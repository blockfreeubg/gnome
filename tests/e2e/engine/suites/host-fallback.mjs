// Lane a: the controlled fallback on the real stack (port of the spike's `fallback` suite; ENGINE-PROTOCOL §6.2):
// a Scramjet engine failure of a GET (error hook, via the e2e build's fault `sj-throw-marker`) is retried once on
// Ultraviolet with the same navId and the site's Scramjet cookies (HttpOnly included) copied into UV's jar; a failed
// POST is never re-sent (fallback available, idempotent false); the next user navigation goes back to Scramjet; an
// HTTP 404 page is not a failure; a destination that never answers times out on Scramjet, falls back, and ends with
// tab.error {timeout, attempted}. Part `init-failed` (worklist A4): gnome-server restarted on a copy of the build whose
// scramjet.wasm is corrupt: Scramjet fails to initialize, every navigation goes to Ultraviolet, and each tab gets
// exactly one tab.engineSwitched {reason: 'init-failed'}, on its first navigation.
//
// Parts (`--parts`, all by default): hooks (the rows above), init-failed.
import fs from 'node:fs';
import path from 'node:path';
import { PERMS, fixtureQuery, inFrame, realClick, startFixtures } from './host-lib.mjs';

/** A copy of the build `from` in `to` (hard links where possible) with vendor/scramjet/scramjet.wasm corrupted. */
function corruptWasmCopy(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, e.name);
      const b = path.join(dst, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        try {
          fs.linkSync(a, b);
        } catch {
          fs.copyFileSync(a, b);
        }
      }
    }
  };
  walk(from, to);
  const wasm = path.join(to, 'vendor', 'scramjet', 'scramjet.wasm');
  if (!fs.existsSync(wasm)) throw new Error(`no scramjet.wasm in ${from}`);
  fs.rmSync(wasm); // a new file: the build's own copy (a hard link) stays intact
  fs.writeFileSync(wasm, Buffer.from('this is not WebAssembly: GNOME e2e init-failed row'));
  return to;
}

/** test.* answers cannot pass the driver's result validation (no such command in the protocol): the command ran. */
async function testCmd(app, type, p) {
  try {
    await app.cmd(type, p);
  } catch (e) {
    if (!/invalid test\./.test(String(e.message))) throw e;
  }
}

export async function run(ctx) {
  const want = (part) => !ctx.parts || ctx.parts.includes(part);
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    if (want('hooks')) await hookRows(ctx, fx, context);
    if (want('init-failed')) await initFailed(ctx, fx, browser);
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}

/**
 * ENGINE-PROTOCOL §6.2: Scramjet failing to initialize sends every navigation to Ultraviolet, and each tab gets one
 * tab.engineSwitched {reason: 'init-failed'}, on its first navigation (tabs.ts). Tab 1 navigates twice, tab 2 once.
 */
async function initFailed(ctx, fx, browser) {
  const test = 'fallback:init-failed (corrupt scramjet.wasm) → every navigation on ultraviolet, one tab.engineSwitched per tab';
  const dir = corruptWasmCopy(ctx.stack.staticDir, path.join(ctx.runDir, `dist-corrupt-wasm-${ctx.browser}`));
  await ctx.stack.restartServer({ GNOME_STATIC_DIR: dir });
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { engine: 'auto', fallback: '1' }));
    const engines = app.init?.status?.engines ?? {};
    const s0 = await app.mark();
    const a1 = await app.navigate(1, `${fx.origin}/`, { create: true, timeout: 45000 });
    const a2 = await app.navigate(1, `${fx.origin}/second`, { timeout: 45000 });
    const b1 = await app.navigate(2, `${fx.origin}/third`, { create: true, timeout: 45000 });
    await ctx.sleep(1000);
    const sw = (await app.eventsSince(s0)).filter((e) => e.type === 'tab.engineSwitched').map((e) => e.p);
    const per = (id) => sw.filter((p) => p.tabId === id);
    const firstNav = (r) => r.committed?.navId ?? null;
    const okSwitch = (id, r) => per(id).length === 1 && per(id)[0].reason === 'init-failed' && per(id)[0].from === 'scramjet' && per(id)[0].to === 'ultraviolet' && per(id)[0].navId === firstNav(r);
    const loads = [a1, a2, b1];
    const rejected = (await app.gnome(() => window.gnomeTest.rejected)).filter((r) => !String(r.kind).startsWith('result:test.'));
    const ok =
      engines.scramjet?.state === 'failed' && /wasm/.test(engines.scramjet?.detail ?? '') && engines.ultraviolet?.state === 'ready' &&
      loads.every((r) => r.ok && r.engine === 'ultraviolet') && okSwitch(1, a1) && okSwitch(2, b1) && sw.length === 2 && rejected.length === 0;
    ctx.record({
      test,
      result: ok ? 'pass' : 'fail',
      notes: `scramjet ${engines.scramjet?.state} (${engines.scramjet?.detail}), ultraviolet ${engines.ultraviolet?.state}; loads ${loads.map((r) => `${r.ok ? 'ok' : 'FAIL'}/${r.engine}`).join(' ')}; switches ${JSON.stringify(sw)}; invalid events ${rejected.length}`,
    });
    await app.close();
  } catch (e) {
    ctx.record({ test, result: 'fail', notes: `threw: ${String(e?.stack ?? e).slice(0, 400)}` });
  } finally {
    await context.close();
    await ctx.stack.restartServer({});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function hookRows(ctx, fx, context) {
  {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { engine: 'auto', fallback: '1' }));
    await testCmd(app, 'test.setFault', { fault: 'sj-throw-marker' });
    const tab = 1;

    // Error hook → UV with cookies.
    {
      const c = await app.navigate(tab, `${fx.origin}/cookies/set`, { create: true, timeout: 45000 });
      const s = await app.mark();
      const r = await app.navigate(tab, `${fx.origin}/cookies?gnome-fault=sj-throw`, { timeout: 60000 });
      const sw = (await app.eventsSince(s)).filter((e) => e.type === 'tab.engineSwitched' && e.p.tabId === tab);
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const cookies = f ? await inFrame(f, () => document.getElementById('cookies')?.textContent ?? null).catch(() => null) : null;
      const ok = c.ok && c.engine === 'scramjet' && r.ok && r.engine === 'ultraviolet' && sw.length === 1 && sw[0].p.reason === 'error-hook' && sw[0].p.navId === r.committed?.navId && /sid=s3cr3t/.test(cookies ?? '') && /pref=dark/.test(cookies ?? '');
      ctx.record({ test: 'fallback:error-hook → ultraviolet, same navId, cookies incl. HttpOnly', result: ok ? 'pass' : 'fail', notes: `first ${c.engine}; switched ${JSON.stringify(sw.map((e) => e.p))}; loaded on ${r.engine} navId ${r.committed?.navId}; UV saw cookies ${JSON.stringify(cookies)}; error ${JSON.stringify(r.error)}` });
    }
    // The next user navigation goes back to Scramjet.
    {
      const r = await app.navigate(tab, `${fx.origin}/second`, { timeout: 45000 });
      ctx.record({ test: 'fallback:next user navigation returns to Scramjet', result: r.ok && r.engine === 'scramjet' ? 'pass' : 'fail', notes: `engine ${r.engine} ok ${r.ok}` });
    }
    // A failed POST is never re-sent.
    {
      const a = await app.navigate(tab, `${fx.origin}/form-fault`, { timeout: 45000 });
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const before = fx.hits('/echo');
      const s = await app.mark();
      if (a.ok && f) await realClick(app, f, '#post');
      const err = await app.waitFor(s, (e) => e.type === 'tab.error' && e.p.tabId === tab, 30000);
      await ctx.sleep(1500);
      const sw = (await app.eventsSince(s)).filter((e) => e.type === 'tab.engineSwitched');
      const sent = fx.hits('/echo') - before;
      const ok = err && err.p.idempotent === false && err.p.fallback === 'available' && err.p.engine === 'scramjet' && sw.length === 0 && sent === 0;
      ctx.record({ test: 'fallback:POST not retried', result: ok ? 'pass' : 'fail', notes: `error ${JSON.stringify(err?.p ?? null)}; switches ${sw.length}; POSTs that reached the site ${sent}` });
    }
    // An HTTP 404 page renders: no failure, no fallback.
    {
      const s = await app.mark();
      const r = await app.navigate(tab, `${fx.origin}/gnome-404`, { timeout: 45000 });
      const sw = (await app.eventsSince(s)).filter((e) => e.type === 'tab.engineSwitched');
      ctx.record({ test: 'fallback:404 is not a failure', result: r.ok && r.engine === 'scramjet' && sw.length === 0 ? 'pass' : 'fail', notes: `ok ${r.ok} engine ${r.engine} title ${JSON.stringify(r.title)} switches ${sw.length}` });
    }
    // Timeout on both engines.
    {
      await app.cmd('tab.navigate', { tabId: tab, url: `${fx.origin}/second`, engine: null, permissions: PERMS });
      await ctx.sleep(1500);
      const s = await app.mark();
      await app.cmd('tab.navigate', { tabId: tab, url: `${fx.origin}/hang`, engine: null, permissions: PERMS });
      const err = await app.waitFor(s, (e) => e.type === 'tab.error' && e.p.tabId === tab, 60000);
      const sw = (await app.eventsSince(s)).filter((e) => e.type === 'tab.engineSwitched');
      const ok = err && err.p.kind === 'timeout' && err.p.fallback === 'attempted' && err.p.engine === 'ultraviolet' && sw.length === 1 && sw[0].p.reason === 'timeout';
      ctx.record({ test: 'fallback:timeout → ultraviolet → timeout (attempted)', result: ok ? 'pass' : 'fail', notes: `switches ${JSON.stringify(sw.map((e) => e.p))}; error ${JSON.stringify(err?.p ?? null)}` });
    }
    await testCmd(app, 'test.setFault', { fault: null });
    await app.close();
  }
}
