// Lane a: popups and new tabs on the real stack (ENGINE-PROTOCOL §6.3; WAVE-B §2 Tests): window.open with and without
// the user's activation, a popup features string, about:blank, target=_blank and named-target links, middle- and
// Ctrl-clicks, GET and POST forms with target=_blank, window.close, and (row `popups:targets`) the `_top`/`_parent`,
// form.submit(), <base target> and sibling-frame targets the sandbox refuses. tab.openRequest must be the only result (the
// browser opens nothing: no page appears in the context), window.open returns null to the page, and the app
// document's own transient activation at the moment each openRequest arrives is recorded (decideOpen needs both the
// engine host's claim and the app's own activation): an init script in the driver page notes
// navigator.userActivation.isActive for every port message, so the suite never evaluates (with a gesture) while it
// measures.
import { fixtureQuery, inFrame, perEngine, realClick, startFixtures } from './host-lib.mjs';

/** Driver page only: record the app document's activation when each engine event arrives on the port. */
function recordAppActivation() {
  if (!location.pathname.startsWith('/e2e-driver/')) return;
  window.__act = [];
  const seen = new WeakSet();
  const wrap = (fn) =>
    function (ev) {
      try {
        const d = ev && ev.data;
        if (d && d.k === 'evt' && !seen.has(ev)) {
          seen.add(ev);
          const ua = navigator.userActivation;
          window.__act.push({ type: d.type, p: d.p, appActive: ua ? ua.isActive : null, at: Date.now() });
        }
      } catch {
        /* never break the driver */
      }
      return fn.call(this, ev);
    };
  const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    ...d,
    set(fn) {
      d.set.call(this, typeof fn === 'function' ? wrap(fn) : fn);
    },
  });
  const add = MessagePort.prototype.addEventListener;
  MessagePort.prototype.addEventListener = function (type, fn, opts) {
    return add.call(this, type, type === 'message' && typeof fn === 'function' ? wrap(fn) : fn, opts);
  };
}

async function openRequestsSince(app, at) {
  const act = await app.page.evaluate(() => window.__act ?? []);
  return act.filter((a) => a.type === 'tab.openRequest' && a.at >= at);
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  await context.addInitScript(recordAppActivation);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    let next = 1;
    const pagesBefore = context.pages().length;

    await perEngine(ctx, 'popups:routing', async (engine) => {
      const id = next++;
      const a = await app.navigate(id, `${fx.origin}/popups`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `popups page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      if (!f) return { result: 'fail', notes: 'frame not ready' };
      // Element positions first: every read of the frame may grant activation (playwright-core evaluates with a
      // gesture), so nothing is evaluated between a click and the reading of what the app recorded for it.
      const boxes = {};
      for (const sel of ['#open', '#open-popup', '#open-blank', '#blank', '#named', '#plain', '#g-submit', '#p-submit']) {
        const b = await (await f.waitForSelector(sel)).boundingBox();
        boxes[sel] = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      // Let that expire (5 s in both browsers); the page's own timer opens /timer without any activation meanwhile.
      await ctx.sleep(9000);
      const rows = [];
      const check = async (label, sel, pred, opts = {}) => {
        const at = Date.now();
        if (opts.ctrl) await app.page.keyboard.down('Control');
        await app.page.mouse.click(boxes[sel].x, boxes[sel].y, opts.button ? { button: opts.button } : {});
        if (opts.ctrl) await app.page.keyboard.up('Control');
        await ctx.sleep(1500);
        const got = await openRequestsSince(app, at);
        await ctx.sleep(5600); // the click's gesture and the read's expire before the next click
        if (pred === null) {
          rows.push(`${label}: ${got.length === 0 ? 'ok (nothing)' : 'FAIL ' + JSON.stringify(got[0].p)}`);
          return got.length === 0;
        }
        const r = got[0];
        const ok = !!r && got.length === 1 && r.p.openerTabId === id && pred(r.p, r.appActive);
        rows.push(`${label}: ${ok ? 'ok' : 'FAIL'} ${r ? `${r.p.url.replace(fx.origin, '')} ${r.p.disposition} claim=${r.p.userActivation} app=${r.appActive}${got.length > 1 ? ` (+${got.length - 1} more)` : ''}` : 'no openRequest'}`);
        return ok;
      };
      const timer = (await openRequestsSince(app, 0)).find((r) => r.p.openerTabId === id && r.p.url.endsWith('/timer'));
      await ctx.sleep(5600);
      const results = [];
      results.push(!!timer && timer.p.userActivation === false && timer.appActive === false);
      rows.push(`timer window.open (no gesture): ${timer ? `claim=${timer.p.userActivation} app=${timer.appActive}` : 'no openRequest'}`);
      results.push(await check('window.open (click)', '#open', (p, appAct) => p.url === `${fx.origin}/second` && p.disposition === 'foreground' && p.userActivation === true && appAct === true));
      results.push(await check('window.open popup features', '#open-popup', (p, appAct) => p.disposition === 'popup' && p.userActivation === true && appAct === true));
      results.push(await check('window.open about:blank', '#open-blank', null));
      results.push(await check('target=_blank link', '#blank', (p, appAct) => p.url === `${fx.origin}/third` && p.disposition === 'foreground' && p.userActivation === true && appAct === true));
      results.push(await check('named target link', '#named', (p, appAct) => p.url === `${fx.origin}/third` && p.disposition === 'foreground' && appAct === true));
      results.push(await check('middle-click', '#plain', (p, appAct) => p.url === `${fx.origin}/third` && p.disposition === 'background' && appAct === true, { button: 'middle' }));
      results.push(await check('ctrl+click', '#plain', (p, appAct) => p.url === `${fx.origin}/third` && p.disposition === 'background' && appAct === true, { ctrl: true }));
      results.push(await check('GET form target=_blank', '#g-submit', (p, appAct) => p.url === `${fx.origin}/echo?q=g1` && p.disposition === 'foreground' && p.userActivation === true && appAct === true));
      // window.open returned null to the page; the tab did not navigate.
      const ret = await inFrame(f, () => [window.__r === null, location.pathname.length > 0]);
      results.push(ret[0] === true);
      rows.push(`window.open return value: ${ret[0] ? 'null' : 'NOT null'}`);
      // POST form with target=_blank: submitted in this tab.
      const s = await app.mark();
      await app.page.mouse.click(boxes['#p-submit'].x, boxes['#p-submit'].y);
      const commit = await app.waitFor(s, (e) => e.type === 'tab.committed' && e.p.tabId === id, 20000);
      const postOk = !!commit && commit.p.url === `${fx.origin}/echo` && (await openRequestsSince(app, Date.now() - 3000)).length === 0;
      results.push(postOk);
      rows.push(`POST form target=_blank: ${postOk ? 'ok (same tab)' : 'FAIL ' + JSON.stringify(commit?.p)}`);
      // window.close() → tab.closeRequest (back on the popups page first).
      await app.navigate(id, `${fx.origin}/popups`, { engine, timeout: 45000 });
      const f2 = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const s2 = await app.mark();
      if (f2) await realClick(app, f2, '#close');
      const closeReq = await app.waitFor(s2, (e) => e.type === 'tab.closeRequest' && e.p.tabId === id, 10000);
      results.push(!!closeReq);
      rows.push(`window.close: ${closeReq ? 'tab.closeRequest' : 'FAIL none'}`);
      const noNative = context.pages().length === pagesBefore;
      results.push(noNative);
      rows.push(`native pages opened: ${context.pages().length - pagesBefore}`);
      return { result: results.every(Boolean) ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    // Targets the engine iframe's sandbox refuses (a frame may navigate only itself and its descendants): `_top` and
    // `_parent` from the tab's top document (the tab itself) and from a nested one, GET and POST forms, form.submit(),
    // <base target=_blank>, and a sibling frame of a frameset. Before the fix they did nothing at all (both engines,
    // both browsers), or navigated the nested frame instead of the tab (Scramjet empties `_top` on links).
    await perEngine(ctx, 'popups:targets (_top, _parent, forms, form.submit, base target, sibling frame)', async (engine) => {
      const rows = [];
      const results = [];
      const childFrame = async (id, name) => {
        for (let i = 0; i < 60; i++) {
          const c = app.tabFrame(id)?.childFrames().find((fr) => fr.name() === name);
          if (c && (await inFrame(c, () => document.readyState, undefined, 2000).catch(() => null)) === 'complete') return c;
          await ctx.sleep(200);
        }
        return null;
      };
      const once = async (label, path, frameName, sel, expect) => {
        const id = next++;
        const a = await app.navigate(id, `${fx.origin}${path}`, { engine, create: true, timeout: 45000 });
        if (!a.ok) {
          rows.push(`${label}: FAIL page did not load ${JSON.stringify(a.error)}`);
          results.push(false);
          return;
        }
        let f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (f && frameName) f = await childFrame(id, frameName);
        if (!f) {
          rows.push(`${label}: FAIL no frame`);
          results.push(false);
          return;
        }
        const s = await app.mark();
        const at = Date.now();
        await realClick(app, f, sel);
        // Only this tab's requests (the routing row's /popups tab keeps its own timer).
        const mineSince = async () => (await openRequestsSince(app, at)).filter((r) => r.p.openerTabId === id);
        let ok = false;
        let note = '';
        if (expect.commit) {
          const c = await app.waitFor(s, (e) => e.type === 'tab.committed' && e.p.tabId === id, 15000);
          await ctx.sleep(800);
          const opens = await mineSince();
          const echo = expect.echo ? await inFrame(app.tabFrame(id), () => document.getElementById('echo')?.textContent ?? null).catch(() => null) : null;
          ok = !!c && c.p.url === `${fx.origin}${expect.commit}` && opens.length === 0 && (!expect.echo || String(echo ?? '').startsWith(expect.echo));
          note = `${c ? c.p.url.replace(fx.origin, '') : 'no commit'}${echo ? ` "${echo}"` : ''}${opens.length ? ` +${opens.length} openRequest` : ''}`;
        } else if (expect.open) {
          await ctx.sleep(2000);
          const opens = await mineSince();
          const commits = (await app.eventsSince(s)).filter((e) => e.type === 'tab.committed' && e.p.tabId === id);
          ok = opens.length === 1 && opens[0].p.openerTabId === id && opens[0].p.url === `${fx.origin}${expect.open}` && commits.length === 0;
          note = opens.map((o) => `${o.p.url.replace(fx.origin, '')} ${o.p.disposition}`).join(', ') || 'no openRequest';
        } else if (expect.frame) {
          await ctx.sleep(2500);
          const sib = await childFrame(id, expect.frame);
          const echo = sib ? await inFrame(sib, () => document.getElementById('echo')?.textContent ?? null).catch(() => null) : null;
          const evs = (await app.eventsSince(s)).filter((e) => e.p?.tabId === id && (e.type === 'tab.committed' || e.type === 'tab.loading'));
          const opens = await mineSince();
          ok = String(echo ?? '').startsWith(expect.echo) && evs.length === 0 && opens.length === 0;
          note = `${expect.frame}: "${echo}"; tab events ${evs.map((e) => e.type).join(',') || 'none'}`;
        }
        rows.push(`${label}: ${ok ? 'ok' : 'FAIL'} ${note}`);
        results.push(ok);
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
      };
      await once('top _top link', '/targets', null, '#top', { commit: '/second?via=top' });
      await once('top _parent link', '/targets', null, '#parent', { commit: '/second?via=parent' });
      await once('top _top GET form', '/targets', null, '#ftop-b', { commit: '/echo?q=ftop' });
      await once('top _parent GET form', '/targets', null, '#fparent-b', { commit: '/echo?q=fparent' });
      await once('top _top POST form', '/targets', null, '#fptop-b', { commit: '/echo', echo: 'POST /echo q=fptop' });
      await once('nested _top link', '/targets', 'nest', '#ntop', { commit: '/second?via=ntop' });
      await once('nested _parent link', '/targets', 'nest', '#nparent', { commit: '/second?via=nparent' });
      await once('nested _top POST form', '/targets', 'nest', '#nftop-b', { commit: '/echo', echo: 'POST /echo q=nftop' });
      await once('nested form.submit() _top POST', '/targets', 'nest', '#nsub-b', { commit: '/echo', echo: 'POST /echo q=nsubmit' });
      await once('<base target=_blank> link', '/base-blank', null, '#b', { open: '/second?via=base' });
      await once('<base target=_blank> GET form', '/base-blank', null, '#bf-b', { open: '/echo?q=basef' });
      await once('frameset sibling target', '/frames-targets', 'nav', '#sib', { frame: 'main', echo: 'GET /echo?via=sibling' });
      const noNative = context.pages().length === pagesBefore;
      results.push(noNative);
      rows.push(`native pages opened: ${context.pages().length - pagesBefore}`);
      return { result: results.every(Boolean) ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
