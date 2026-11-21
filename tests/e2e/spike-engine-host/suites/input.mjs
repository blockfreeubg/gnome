// Item 7 (spike-core): keyboard-shortcut forwarding, context menus and fullscreen from nested proxied frames,
// and find-in-page across the same-origin proxied frames of a tab. Page: the local target's /nested (top
// document + a same-site child + a cross-site child at localhost), through the TEST-ONLY route.
import { TARGET_ORIGIN } from '../lib/config.mjs';
import { sleep } from '../lib/procs.mjs';

const j = (v) => JSON.stringify(v);
const TRANSPORT = { scramjet: 'libcurl', ultraviolet: 'epoxy' };

async function docFrames(app, tabId, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const top = app.tabFrame(tabId);
    const out = { top: null, same: null, cross: null };
    if (top) {
      try { if (await top.evaluate(() => !!document.getElementById('topInput'))) out.top = top; } catch { /* navigating */ }
      for (const f of top.childFrames()) {
        const who = await f.evaluate(() => document.getElementById('who')?.textContent || null).catch(() => null);
        if (who === 'same-site') out.same = f;
        if (who === 'cross-site') out.cross = f;
      }
    }
    if ((out.top && out.same && out.cross) || Date.now() - t0 > timeout) return out;
    await sleep(150);
  }
}

async function keyCheck(app, tabId, frame, selector, key, combo) {
  await frame.focus(selector);
  const since = await app.mark();
  await app.page.keyboard.press(key);
  const ev = await app.waitFor(since, (e) => e.type === 'tab.key' && e.p.tabId === tabId, 3000);
  const value = await frame.evaluate((s) => document.querySelector(s).value, selector);
  return { ok: ev?.p.combo === combo, got: ev?.p.combo ?? null, value };
}

async function engineLane(ctx, browser, engine) {
  const transport = TRANSPORT[engine];
  const rec = (test, ok, notes) => ctx.record({ engine, transport, test, result: ok ? 'pass' : 'fail', notes });
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, { route: 'test' });
    const tabId = 1;
    const nav = await app.navigate(tabId, `${TARGET_ORIGIN}/nested`, { engine, create: true, timeout: 30000 });
    const fr = await docFrames(app, tabId);
    if (!nav.ok || !fr.top || !fr.same || !fr.cross) {
      rec('nested page loads', false, `nav ${nav.ok ? 'ok' : j(nav.error)}; frames top ${!!fr.top} same ${!!fr.same} cross ${!!fr.cross}`);
      return;
    }

    // ---- keyboard: shortcuts forwarded from every nesting level, other keys stay in the page
    const rows = [];
    let allOk = true;
    for (const [label, f, sel] of [['top document', fr.top, '#topInput'], ['same-site child frame', fr.same, '#childInput'], ['cross-site child frame', fr.cross, '#childInput']]) {
      const a = await keyCheck(app, tabId, f, sel, 'Alt+KeyT', 'Alt+T');
      const b = await keyCheck(app, tabId, f, sel, 'Control+Shift+KeyK', 'Ctrl+Shift+K');
      const c = await keyCheck(app, tabId, f, sel, 'F6', 'F6');
      // Ordinary typing must not be swallowed or forwarded.
      const since = await app.mark();
      await f.fill(sel, '');
      await f.focus(sel);
      await app.page.keyboard.type('gnome');
      const stray = (await app.eventsSince(since)).filter((e) => e.type === 'tab.key').length;
      const typed = await f.evaluate((s) => document.querySelector(s).value, sel);
      const ok = a.ok && b.ok && c.ok && stray === 0 && typed === 'gnome' && a.value === '';
      allOk &&= ok;
      rows.push(`${label}: Alt+T ${a.got}, Ctrl+Shift+K ${b.got}, F6 ${c.got}, typing "${typed}" (${stray} forwarded)`);
    }
    const appSaw = await app.page.evaluate(() => window.gnomeTest.shortcuts.filter((s) => s.source === 'engine').map((s) => s.combo));
    rec('keyboard shortcuts forwarded from nested proxied frames', allOk && appSaw.length === 9, `${rows.join('; ')}; app dispatched ${appSaw.length} engine shortcuts`);

    // ---- context menu: right-click a link in the same-site child; coordinates in engine-host space
    {
      const since = await app.mark();
      const link = await fr.same.$('#childLink');
      const box = await link.boundingBox(); // main-page coordinates
      const engineBox = await (await app.page.$('#engine')).boundingBox();
      await fr.same.click('#childLink', { button: 'right' });
      const ev = await app.waitFor(since, (e) => e.type === 'tab.contextMenu' && e.p.tabId === tabId, 3000);
      const ex = box.x + box.width / 2 - engineBox.x;
      const ey = box.y + box.height / 2 - engineBox.y;
      const want = `${TARGET_ORIGIN}/nested-child?who=same-site-linked`;
      const ok = ev && ev.p.target.kind === 'link' && ev.p.target.linkUrl === want && Math.abs(ev.p.x - ex) <= 3 && Math.abs(ev.p.y - ey) <= 3;
      rec('context menu request from nested frame', !!ok, ev ? `kind ${ev.p.target.kind}, linkUrl ${ev.p.target.linkUrl}, at (${ev.p.x}, ${ev.p.y}) vs expected (${Math.round(ex)}, ${Math.round(ey)}) in engine-host coordinates` : 'no tab.contextMenu event');
      await app.page.keyboard.press('Escape');
    }

    // ---- fullscreen from the cross-site child (allow chain: app iframe allow=fullscreen -> tab iframe allow=fullscreen -> page's allowfullscreen)
    for (const [label, f] of [['cross-site child frame', fr.cross], ['same-site child frame', fr.same]]) {
      const since = await app.mark();
      const enabled = await f.evaluate(() => document.fullscreenEnabled);
      await f.click('#fs');
      let title = null;
      for (let i = 0; i < 30 && !/^fs:/.test(title || ''); i++) { await sleep(100); title = await f.evaluate(() => document.title); }
      const on = await app.waitFor(since, (e) => e.type === 'tab.fullscreen' && e.p.tabId === tabId && e.p.active, 3000);
      const appState = await app.page.evaluate(() => ({ engineIsFullscreen: document.fullscreenElement === document.getElementById('engine'), log: window.gnomeTest.fullscreenLog.length }));
      await app.page.evaluate(() => document.exitFullscreen().catch(() => {}));
      const off = await app.waitFor(since, (e) => e.type === 'tab.fullscreen' && e.p.tabId === tabId && !e.p.active, 3000);
      await f.evaluate(() => { document.title = 'reset'; });
      rec(`fullscreen from ${label}`, enabled && title === 'fs:on' && !!on && appState.engineIsFullscreen && !!off, `fullscreenEnabled ${enabled}; requestFullscreen -> ${title}; tab.fullscreen on ${!!on}, off ${!!off}; app sees engine iframe fullscreen ${appState.engineIsFullscreen}`);
    }

    // ---- find in page across the same-origin proxied documents (top 1 + same-site child 2 + cross-site child 2)
    {
      const r1 = await app.cmd('tab.find', { tabId, query: 'needle' });
      const r2 = await app.cmd('tab.find', { tabId, query: 'needle' });
      const r3 = await app.cmd('tab.find', { tabId, query: 'needle', backwards: true });
      // Highlights live in each document's own CSS.highlights registry (the host's Range objects, page realm).
      const hl = await Promise.all([fr.top, fr.same, fr.cross].map((f) => f.evaluate(() => (CSS.highlights && CSS.highlights.has('gnome-find') ? [...CSS.highlights.get('gnome-find')].length : 0))));
      const r4 = await app.cmd('tab.find', { tabId, query: 'Needle', caseSensitive: true });
      await app.cmd('tab.find', { tabId, query: 'needle' });
      await app.cmd('tab.findClear', { tabId });
      const hl2 = await Promise.all([fr.top, fr.same, fr.cross].map((f) => f.evaluate(() => (CSS.highlights ? CSS.highlights.size : -1))));
      const ok = r1.matches === 5 && r1.active === 1 && r2.active === 2 && r3.active === 1 && r4.matches === 0 && r1.highlights && j(hl) === '[1,2,2]' && j(hl2) === '[0,0,0]';
      rec('find in page across nested same-origin proxied frames', ok, `"needle": ${r1.matches} matches (active ${r1.active} -> next ${r2.active} -> prev ${r3.active}); highlighted ranges top/same/cross ${j(hl)}, after findClear ${j(hl2)}; case-sensitive "Needle": ${r4.matches}`);
    }
    await app.close();
  } finally {
    await context.close();
  }
}

export async function run(ctx) {
  const browser = await ctx.launch();
  try {
    for (const engine of ['scramjet', 'ultraviolet']) {
      try { await engineLane(ctx, browser, engine); } catch (e) { ctx.record({ engine, transport: TRANSPORT[engine], test: 'input: suite error', result: 'fail', notes: String(e.stack || e).slice(0, 400) }); }
    }
  } finally {
    await browser.close();
  }
}
