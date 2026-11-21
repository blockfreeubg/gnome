// Lane a: GNOME's proxied-document CSP on every navigable destination and content type (ENGINE-PROTOCOL §6.16,
// WAVE-B §2 Tests: "CSP on frame/object/embed and an SVG document"). Each fixture document runs a construct both
// engines leave native without the policy (a text node in <style> with a background URL, spike §5.2) pointing at a
// loopback "leak" listener the browsers reach only directly. Expected per document: a securitypolicyviolation in the
// document itself (the policy is present and enforced) and 0 requests at the leak listener (nothing left natively).
// The engine host's own counting (tab.blocked {direct-connection}) is checked for the top document.
import { fixtureQuery, inFrame, perEngine, startFixtures } from './host-lib.mjs';

async function framesByTitle(app, prefix) {
  const out = {};
  out.__frames = app.page.frames().map((f) => `${f.name() || '-'}:${f.url().slice(0, 70)}`);
  for (const f of app.page.frames()) {
    const r = await inFrame(f, () => ({ title: document.title, out: document.getElementById('out')?.textContent ?? null, svg: document.querySelector('svg > title')?.textContent ?? null }), undefined, 2000).catch(() => null);
    if (!r) continue;
    if (r.title.startsWith(prefix)) out[r.title] = r.out;
    if (r.svg) out[`svg:${r.svg}`] = r.svg;
  }
  return out;
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
    let id = 1;
    const parse = (v) => {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    };
    await perEngine(ctx, 'csp:document-iframe-object-embed', async (engine) => {
      fx.leak.reset();
      const tab = id++;
      const s = await app.mark();
      const a = await app.navigate(tab, `${fx.origin}/csp-frames`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      await ctx.sleep(3500);
      const docs = await framesByTitle(app, 'csp ');
      const frames = docs.__frames;
      delete docs.__frames;
      const got = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, parse(v)?.violations?.length ?? v]));
      const loaded = ['csp iframe', 'csp object', 'csp embed'].filter((t) => t in got);
      const covered = loaded.filter((t) => typeof got[t] === 'number' && got[t] > 0);
      const blocked = (await app.eventsSince(s)).filter((e) => e.type === 'tab.blocked' && e.p.tabId === tab).pop();
      const leaks = fx.leak.count();
      // Every fixture document that loaded through the engine must show the policy; one the engine did not load (an
      // <object>/<embed> URL it does not rewrite resolves on the proxy origin, which answers with its own strict
      // policy) is reported, not counted as covered.
      return {
        result: leaks === 0 && got['csp iframe'] > 0 && covered.length === loaded.length ? 'pass' : 'fail',
        notes: `violations per document ${JSON.stringify(got)}; not loaded through the engine: ${['csp object', 'csp embed'].filter((t) => !(t in got)).join(', ') || 'none'}; native requests ${leaks}; tab.blocked ${JSON.stringify(blocked?.p ?? null)}; frames ${frames.join(' ')}`,
      };
    });
    await perEngine(ctx, 'csp:frame (frameset)', async (engine) => {
      fx.leak.reset();
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/csp-frameset`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      await ctx.sleep(3500);
      const docs = await framesByTitle(app, 'csp ');
      const v = parse(docs['csp frame'] ?? 'null')?.violations?.length ?? null;
      const leaks = fx.leak.count();
      return { result: leaks === 0 && v > 0 ? 'pass' : 'fail', notes: `frame document violations ${v}; native requests ${leaks}` };
    });
    await perEngine(ctx, 'csp:top-document + tab.blocked', async (engine) => {
      fx.leak.reset();
      const tab = id++;
      const s = await app.mark();
      const a = await app.navigate(tab, `${fx.origin}/csp-doc?id=top`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
      await ctx.sleep(3000);
      const blocked = (await app.eventsSince(s)).filter((e) => e.type === 'tab.blocked' && e.p.tabId === tab).pop();
      const docs = await framesByTitle(app, 'csp top');
      const v = parse(docs['csp top'] ?? 'null')?.violations?.length ?? null;
      const leaks = fx.leak.count();
      const counted = blocked?.p?.byCategory?.['direct-connection'] ?? 0;
      return { result: leaks === 0 && v > 0 && counted >= 1 ? 'pass' : 'fail', notes: `document violations ${v}; tab.blocked ${JSON.stringify(blocked?.p ?? null)}; native requests ${leaks}` };
    });
    await perEngine(ctx, 'csp:svg-document', async (engine) => {
      fx.leak.reset();
      const tab = id++;
      const a = await app.navigate(tab, `${fx.origin}/csp.svg`, { engine, create: true, timeout: 45000 });
      if (!a.ok) return { result: 'fail', notes: `svg did not load: ${JSON.stringify(a.error)}` };
      await ctx.sleep(3000);
      const f = app.tabFrame(tab);
      const title = f ? await inFrame(f, () => document.querySelector('title')?.textContent ?? null).catch(() => null) : null;
      const leaks = fx.leak.count();
      const n = Number(String(title ?? '').replace('violations:', ''));
      // Neither engine rewrites SVG documents, so their scripts are forbidden (script-src 'none': csp.ts for Scramjet,
      // the SW for UV) and cannot report; the proxied-document policy must still keep every construct off the network.
      const proxied = fx.leak.proxied();
      void n;
      const ok = leaks === 0 && title === 'pending';
      return { result: ok ? 'pass' : 'fail', notes: `svg says ${title}; native requests ${leaks}; proxied requests ${proxied}` };
    });
    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
