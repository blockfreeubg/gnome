// Lane a: port of the spike's `isolation` suite (spike-engine-host/suites/isolation.mjs, item 3) against the BUILT
// engine host and the real gnome-server (WAVE-B §2 Tests): a proxied page must not reach the APP origin. Escaped code
// (unrewritten JS in the proxied document, Playwright frame.evaluate: what any engine escape gives a page) tries to
//   - read the app document (top.location, top.document) and the app origin's storage (top.localStorage)
//   - call the app's authenticated API with the session cookie and the CSRF header (POST /api/wisp/ticket mints a
//     ticket: a success would hand the page a Wisp credential and prove a CSRF hole), from the page's realm and from
//     the engine-host realm (window.top[0]), with fetch and with a form POST into a hidden frame
//   - navigate the app's top-level window away (top.location = …)
// Every attempt must fail, and the app's secret must stay unread. The proxied cookies and storage the escaped code
// CAN reach are the accepted shared-realm limitation (PROGRESS decisions log, 2026-11-11) and are not asserted here.
import { ENGINES, fixtureQuery, inFrame, startFixtures } from './host-lib.mjs';

async function escaped({ APP }) {
  const out = {};
  const t = async (k, f) => {
    try {
      out[k] = await f();
    } catch (e) {
      out[k] = `threw ${e && e.name}`;
    }
  };
  const H = window.top[0];
  await t('topHref', () => String(window.top.location.href));
  await t('topDocument', () => String(window.top.document.title));
  await t('topLocalStorage', () => String(window.top.localStorage.getItem('gnome:secret')));
  const mint = async (realm) => {
    const r = await realm.fetch(`${APP}/api/wisp/ticket`, { method: 'POST', credentials: 'include', headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' }, body: '{}' });
    return `status ${r.status}: ${(await r.text()).slice(0, 60)}`;
  };
  await t('mintFromPage', () => mint(window));
  await t('mintFromEngineHost', () => mint(H));
  await t('noCorsFromPage', async () => {
    const r = await fetch(`${APP}/api/wisp/ticket`, { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' });
    return `opaque ${r.type}`;
  });
  await t('formPost', () => new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.name = 'sink';
    document.body.appendChild(f);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = `${APP}/api/wisp/ticket`;
    form.target = 'sink';
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => {
      try {
        resolve(`readable: ${String(f.contentDocument?.body?.textContent).slice(0, 60)}`);
      } catch (e) {
        resolve(`not readable (${e.name})`);
      }
    }, 2500);
  }));
  await t('navigateTop', () => {
    window.top.location.href = 'https://escaped-top.gnome-spike.invalid/';
    return 'assigned';
  });
  return out;
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, fixtureQuery(ctx));
    const appUrl = app.page.url();
    await app.page.evaluate(() => localStorage.setItem('gnome:secret', 'app-secret-123'));
    let id = 1;
    for (const engine of ENGINES) {
      const tab = id++;
      try {
        const a = await app.navigate(tab, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) throw new Error(`page did not load: ${JSON.stringify(a.error)}`);
        const tickets0 = await app.gnome(() => window.gnomeTest.tickets?.length ?? null);
        const t0 = Date.now();
        const f = app.tabFrame(tab);
        const out = await inFrame(f, escaped, { APP: ctx.stack.appOrigin }, 20000);
        await ctx.sleep(1500);
        const appStill = app.page.url() === appUrl && !app.page.isClosed();
        const sentinel = ctx.stack.sentinel.since(t0).filter((e) => String(e.target ?? e.url ?? '').includes('escaped-top')).length;
        const tickets1 = await app.gnome(() => window.gnomeTest.tickets?.length ?? null);
        const leakedSecret = JSON.stringify(out).includes('app-secret-123');
        // A ticket answer has a "value"; gnome-server's refusals are {"error": …} (the page's own fetch and form go
        // through its engine, i.e. Wisp, without the app's cookies, and are refused for their Origin / CSRF header).
        const minted = [out.mintFromPage, out.mintFromEngineHost, out.formPost].some((v) => /"value"\s*:/.test(String(v)) || /^status 2\d\d/.test(String(v)));
        const readable = [out.topHref, out.topDocument].some((v) => !String(v).startsWith('threw'));
        const ok = !leakedSecret && !minted && !readable && appStill && sentinel === 0;
        ctx.record({
          test: 'isolation:escaped-code vs the app origin',
          engine,
          result: ok ? 'pass' : 'fail',
          notes: `${JSON.stringify(out).slice(0, 900)}; app page unchanged ${appStill}; top navigation reached the network ${sentinel}; app tickets ${tickets0}→${tickets1} (the app's own)`,
        });
      } catch (e) {
        ctx.record({ test: 'isolation:escaped-code vs the app origin', engine, result: 'fail', notes: `threw: ${String(e.message || e).slice(0, 300)}` });
      }
    }
    const rejected = await app.gnome(() => window.gnomeTest.rejected);
    ctx.record({ test: 'isolation:app-side:no-invalid-events', result: rejected.length === 0 ? 'pass' : 'fail', notes: JSON.stringify(rejected).slice(0, 300) });
    await app.close();
  } finally {
    await context.close();
    await browser.close();
    await fx.close();
  }
}
