// Lane a: input in proxied documents on the real stack (port of the spike's `input` suite plus the WAVE-B §2 rows):
// forwarded shortcuts matched with src/lib/keys.ts from the top document and a nested frame (typing and text-editing
// combos in an editable target are not forwarded), context-menu kinds (link, image, editable, selection, page, a
// selection over 100 000 characters → selectionTruncated, coordinates arrive as integers at the click position,
// Shift+right-click keeps the browser's menu), page fullscreen (tab.fullscreen), and find in page across a nested
// frame (next, previous, clear).
import { fixtureQuery, inFrame, perEngine, startFixtures } from './host-lib.mjs';

const COMBOS = 'Alt+T,Mod+Shift+K,F6,Mod+A';

async function ready(app, tab) {
  const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
  if (!f) throw new Error('frame not ready');
  return f;
}

async function center(frame, sel) {
  const b = await (await frame.waitForSelector(sel)).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0', combos: COMBOS }));
    const engineFrame = await app.page.$('iframe');
    const hostBox = await engineFrame.boundingBox();
    let id = 1;

    await perEngine(ctx, 'keys:forwarded-top-nested-editable', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/input`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await ready(app, tab);
      const nested = await (await f.waitForSelector('#nested')).contentFrame();
      await ctx.sleep(800);
      const keysSince = async (s) => (await app.eventsSince(s)).filter((e) => e.type === 'tab.key' && e.p.tabId === tab).map((e) => e.p.combo);
      const rows = [];
      const step = async (label, focus, press, want) => {
        await focus();
        const s = await app.mark();
        await app.page.keyboard.press(press);
        await ctx.sleep(400);
        const got = await keysSince(s);
        const ok = JSON.stringify(got) === JSON.stringify(want);
        rows.push(`${label}: ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(got)}`);
        return ok;
      };
      const body = await center(f, 'p');
      const focusBody = () => app.page.mouse.click(body.x, body.y);
      const focusInput = () => f.focus('#in');
      const focusNested = () => nested.focus('#cin');
      const r = [
        await step('Alt+T in the page', focusBody, 'Alt+KeyT', ['Alt+T']),
        await step('F6 in the page', focusBody, 'F6', ['F6']),
        await step('typing in an input', focusInput, 'KeyA', []),
        await step('Mod+A in an input (text editing)', focusInput, 'Control+KeyA', []),
        await step('Mod+A on the page', focusBody, 'Control+KeyA', ['Mod+A']),
        await step('Mod+Shift+K in a nested frame input', focusNested, 'Control+Shift+KeyK', ['Mod+Shift+K']),
        await step('Alt+T in a nested frame input', focusNested, 'Alt+KeyT', ['Alt+T']),
      ];
      return { result: r.every(Boolean) ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    await perEngine(ctx, 'context-menu:kinds-coordinates-truncation', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/ctx`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await ready(app, tab);
      await ctx.sleep(500);
      const rows = [];
      const menu = async (label, at, check, opts = {}) => {
        const s = await app.mark();
        if (opts.shift) await app.page.keyboard.down('Shift');
        await app.page.mouse.click(at.x, at.y, { button: 'right' });
        if (opts.shift) await app.page.keyboard.up('Shift');
        await ctx.sleep(500);
        const ev = (await app.eventsSince(s)).filter((e) => e.type === 'tab.contextMenu' && e.p.tabId === tab).pop();
        const ok = check(ev?.p ?? null, at);
        rows.push(`${label}: ${ok ? 'ok' : 'FAIL'} ${ev ? `${ev.p.target.kind} (${ev.p.x},${ev.p.y}) link=${ev.p.target.linkUrl} src=${ev.p.target.srcUrl} sel=${ev.p.target.selectionText ? ev.p.target.selectionText.length : null}${ev.p.target.selectionTruncated ? ' truncated' : ''}` : 'none'}`);
        return ok;
      };
      // App-page coordinates of the click minus the engine iframe's offset = engine-host viewport coordinates.
      const near = (p, at) => p && Number.isInteger(p.x) && Number.isInteger(p.y) && Math.abs(p.x - (at.x - hostBox.x)) <= 2 && Math.abs(p.y - (at.y - hostBox.y)) <= 2;
      const link = await center(f, '#ln');
      const img = await center(f, '#im');
      const inp = await center(f, '#in');
      const txt = await center(f, '#txt');
      const r = [];
      r.push(await menu('link', { x: link.x + 0.4, y: link.y + 0.6 }, (p, at) => near(p, at) && p.target.kind === 'link' && p.target.linkUrl === `${fx.origin}/second`));
      r.push(await menu('image', img, (p, at) => near(p, at) && p.target.kind === 'image' && p.target.srcUrl === `${fx.origin}/favicon.png`));
      r.push(await menu('editable', inp, (p) => p?.target.kind === 'editable' && p.target.editable === true));
      r.push(await menu('page', { x: txt.x + 200, y: txt.y + 60 }, (p) => p?.target.kind === 'page'));
      await inFrame(f, () => {
        const r2 = document.createRange();
        r2.selectNodeContents(document.getElementById('txt'));
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r2);
      });
      r.push(await menu('selection', txt, (p) => p?.target.kind === 'selection' && p.target.selectionText === 'selectable text' && !p.target.selectionTruncated));
      await inFrame(f, () => {
        const r2 = document.createRange();
        r2.selectNodeContents(document.getElementById('big'));
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r2);
      });
      const big = await center(f, '#big');
      r.push(await menu('selection over 100 000', big, (p) => p?.target.kind === 'selection' && p.target.selectionTruncated === true && p.target.selectionText.length === 100000));
      r.push(await menu('shift+right-click', txt, (p) => p === null, { shift: true }));
      await app.page.keyboard.press('Escape');
      return { result: r.every(Boolean) ? 'pass' : 'fail', notes: rows.join(' | ') };
    });

    await perEngine(ctx, 'fullscreen:page-element', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/input`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await ready(app, tab);
      const s = await app.mark();
      const at = await center(f, '#fs');
      await app.page.mouse.click(at.x, at.y);
      const on = await app.waitFor(s, (e) => e.type === 'tab.fullscreen' && e.p.tabId === tab && e.p.active === true, 8000);
      const appFs = await app.page.evaluate(() => !!document.fullscreenElement);
      await inFrame(f, () => document.exitFullscreen().catch(() => null));
      const off = await app.waitFor(s, (e) => e.type === 'tab.fullscreen' && e.p.tabId === tab && e.p.active === false, 8000);
      return { result: on && off && appFs ? 'pass' : 'fail', notes: `on ${!!on} (app fullscreen element ${appFs}), off ${!!off}` };
    });

    await perEngine(ctx, 'find:nested-next-previous-clear', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/input`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      await ready(app, tab);
      await ctx.sleep(500);
      const q = { tabId: tab, query: 'needle', backwards: false, caseSensitive: false };
      const r1 = await app.cmd('tab.find', q);
      const r2 = await app.cmd('tab.find', q);
      const r3 = await app.cmd('tab.find', { ...q, backwards: true });
      const r4 = await app.cmd('tab.find', { ...q, query: 'NEEDLE', caseSensitive: true });
      await app.cmd('tab.findClear', { tabId: tab });
      const ok = r1.matches === 2 && r1.active === 1 && r2.active === 2 && r3.active === 1 && r4.matches === 0 && r1.highlights === true;
      return { result: ok ? 'pass' : 'fail', notes: `first ${JSON.stringify(r1)} next ${JSON.stringify(r2)} previous ${JSON.stringify(r3)} case-sensitive ${JSON.stringify(r4)}` };
    });

    const rejected = (await app.gnome(() => window.gnomeTest.rejected)).filter((r) => !String(r.kind).startsWith('result:test.'));
    ctx.record({ test: 'app-side:no-invalid-events', result: rejected.length === 0 ? 'pass' : 'fail', notes: JSON.stringify(rejected).slice(0, 400) });
    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
