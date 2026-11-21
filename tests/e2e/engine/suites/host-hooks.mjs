// Lane a: the Wave B step-3 hook points (WAVE-B §9, ENGINE-PROTOCOL §6.17) with real verdicts, before any content
// blocker exists. The e2e build's `test.hooks` registers hooks through registerEngineHooks() (src/engine-host/hooks.ts)
// that block WebSockets and requests whose URL carries a marker and mark every document they see:
// - onWebSocket: Ultraviolet pages through the engine host's wrapper of Ultraviolet.BareClient.prototype.createWebSocket
//   in each UV document; Scramjet pages through the transport manager's useHooks() (lane b), both asked by the core;
// - onRequest: Scramjet's per-tab plugin (`fetch.request`) for a subresource, and for the tab's own document, which
//   then fails with tab.error {kind: 'blocked'} (Ultraviolet requests are hooked in the service worker: registerSwHooks,
//   lane b; not reachable from here, so UV loads them);
// - onDocument: Scramjet init.post and the UV document-start hook.
// A WebSocket and a request without the marker go through in both engines.
import { fixtureQuery, inFrame, perEngine, startFixtures } from './host-lib.mjs';

async function testCmd(app, type, p) {
  try {
    await app.cmd(type, p);
  } catch (e) {
    if (!/invalid test\./.test(String(e.message))) throw e;
  }
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    const target = ctx.stack.target?.origin;
    if (!target) {
      ctx.record({ test: 'hooks:setup', result: 'fail', notes: 'the runner started no target site (WebSocket echo)' });
      return;
    }
    const ws = `${target.replace(/^http/, 'ws')}/ws`;
    let id = 1;
    await perEngine(ctx, 'hooks:onWebSocket, onRequest, onDocument (blocking verdicts)', async (engine) => {
      const tab = id++;
      await testCmd(app, 'test.hooks', { blockWebSocket: 'gnome-block-ws', blockRequest: 'gnome-block-req', markDocuments: true });
      try {
        const a = await app.navigate(tab, `${fx.origin}/hooks`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (!f) return { result: 'fail', notes: 'frame not ready' };
        const allowed = await inFrame(f, (u) => window.wsTry(u), ws, 15000);
        const blocked = await inFrame(f, (u) => window.wsTry(`${u}?gnome-block-ws=1`), ws, 15000);
        const imgs = await inFrame(f, () => ({ ok: window.imgState('ok'), blocked: window.imgState('blocked'), mark: window.__gnomeTestDocument ?? null }));
        // The tab's own document with the request marker.
        const doc = await app.navigate(tab, `${fx.origin}/second?gnome-block-req=1`, { engine, timeout: 30000 });
        const docErr = doc.error && typeof doc.error === 'object' ? doc.error : null;
        const sj = engine === 'scramjet';
        const checks = [
          allowed === 'echo hi',
          blocked !== 'echo hi' && blocked !== 'timeout',
          imgs.ok === 'loaded',
          sj ? imgs.blocked === 'broken' : imgs.blocked === 'loaded',
          imgs.mark === `${engine}:top`,
          sj ? docErr?.kind === 'blocked' && docErr?.signal === 'blocked' : doc.ok === true,
        ];
        return {
          result: checks.every(Boolean) ? 'pass' : 'fail',
          notes: `ws without marker: ${allowed}; ws with marker: ${blocked}; img ${imgs.ok}/${imgs.blocked} (marker ${sj ? 'blocked by onRequest' : 'UV: SW-side hooks'}); onDocument mark ${imgs.mark}; document with marker: ${doc.ok ? 'loaded' : JSON.stringify(docErr ?? doc.error).slice(0, 160)}; checks ${checks.map((c) => (c ? 1 : 0)).join('')}`,
        };
      } finally {
        await testCmd(app, 'test.hooks', {});
        await app.cmd('tab.close', { tabId: tab }).catch(() => {});
      }
    });
    // Unregistered again: the marker goes through (ALLOW_ALL).
    await perEngine(ctx, 'hooks:unregistered → ALLOW_ALL', async (engine) => {
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/hooks`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      const f = await app.waitTabFrame(tab, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
      const blocked = await inFrame(f, (u) => window.wsTry(`${u}?gnome-block-ws=1`), ws, 15000);
      const imgs = await inFrame(f, () => ({ blocked: window.imgState('blocked'), mark: window.__gnomeTestDocument ?? null }));
      await app.cmd('tab.close', { tabId: tab }).catch(() => {});
      const ok = blocked === 'echo hi' && imgs.blocked === 'loaded' && imgs.mark === null;
      return { result: ok ? 'pass' : 'fail', notes: `ws with marker: ${blocked}; img with marker: ${imgs.blocked}; onDocument mark ${imgs.mark}` };
    });
    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
