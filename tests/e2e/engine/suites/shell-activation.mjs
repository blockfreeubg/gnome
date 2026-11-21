// Lane c, day one (docs/WAVE-B.md §4 Tests; ENGINE-PROTOCOL §6.3 and §6.7): does a click or a key press inside a
// proxied frame give the *app* document transient user activation?
//
// decideOpen() (src/shared/site-rules.ts) counts a popup request as a gesture only when the engine host's claim AND
// the app document's own navigator.userActivation.isActive are true, and privileged forwarded shortcuts need the
// app's activation too. Both depend on activation propagating from a nested cross-origin frame to its ancestors.
//
// The fixture has the real topology without any engine: an app page on one origin embeds `<proxy>/engine/` with the
// exact sandbox and allow of ARCHITECTURE §4.6 (no allow-popups); the "engine host" connects with the hello/connect
// handshake over a MessagePort and embeds a "tab frame" (same origin as the engine host, like a proxied document),
// which embeds a nested same-origin frame and a nested cross-site frame. Every input is a real (trusted) mouse or
// keyboard event from playwright-core. The app records, at the moment each port message arrives, its own
// navigator.userActivation.isActive.
//
// Runs under tests/e2e/engine/run.mjs (lane b) as suite `shell-activation`, or standalone:
//   node tests/e2e/engine/suites/shell-activation.mjs [--browser chromium|firefox|all]
import { portBase, runStandalone, staticServer } from './shell-lib.mjs';

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation';
const ALLOW = 'fullscreen; clipboard-write; autoplay';
/** Both browsers expire transient activation after 5 s (Chromium kActivationLifespan, Firefox dom.user_activation.transient.timeout). */
const EXPIRE_MS = 6000;

const appPage = (proxyOrigin) => `<!doctype html><meta charset="utf-8"><title>app</title>
<style>body{margin:0;font:14px system-ui}#bar{height:60px;display:flex;align-items:center;gap:8px;padding:0 12px}iframe{border:0;width:1200px;height:760px;display:block}</style>
<div id="bar"><button id="appbtn">app button</button></div>
<script>
  window.__records = [];
  window.__connected = false;
  const act = () => (navigator.userActivation ? { active: navigator.userActivation.isActive, been: navigator.userActivation.hasBeenActive } : null);
  window.__appActivation = act;
  const iframe = document.createElement('iframe');
  iframe.title = 'Browser content';
  iframe.setAttribute('sandbox', ${JSON.stringify(SANDBOX)});
  iframe.setAttribute('allow', ${JSON.stringify(ALLOW)});
  iframe.src = ${JSON.stringify(`${proxyOrigin}/engine/`)};
  let expecting = true;
  addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow || ev.origin !== ${JSON.stringify(proxyOrigin)}) return;
    if (!expecting || !ev.data || ev.data.gnome !== 'hello') return;
    expecting = false;
    const ch = new MessageChannel();
    ch.port1.onmessage = (m) => {
      const a = act();
      const r = { ...m.data, appActive: a ? a.active : null, appBeen: a ? a.been : null, at: Math.round(performance.now()) };
      window.__records.push(r);
      console.log('GNOME-ACT ' + JSON.stringify(r));
    };
    iframe.contentWindow.postMessage({ gnome: 'connect', instance: ev.data.instance }, ${JSON.stringify(proxyOrigin)}, [ch.port2]);
    window.__connected = true;
    console.log('GNOME-CONNECTED');
  });
  document.body.append(iframe);
  // The suite never calls page.evaluate while it measures: playwright-core evaluates with a user gesture, which
  // would activate the documents itself. The state is reported on the console instead.
  setInterval(() => console.log('GNOME-TICK ' + JSON.stringify(act())), 250);
</script>`;

const enginePage = (appOrigin) => `<!doctype html><meta charset="utf-8"><title>engine</title>
<style>body{margin:0}iframe{border:0;width:1180px;height:740px}</style>
<script>
  const instance = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  let port = null;
  const hello = setInterval(() => parent.postMessage({ gnome: 'hello', instance }, ${JSON.stringify(appOrigin)}), 100);
  addEventListener('message', (ev) => {
    if (ev.source !== parent || ev.origin !== ${JSON.stringify(appOrigin)} || port) return;
    if (!ev.data || ev.data.gnome !== 'connect' || ev.data.instance !== instance || ev.ports.length !== 1) return;
    port = ev.ports[0];
    clearInterval(hello);
  });
  // Called by the tab frames (same origin) with the claim they read in their own realm, like the engine host's
  // per-document observers do.
  window.__report = (kind, claim, extra) => {
    const engineActive = navigator.userActivation ? navigator.userActivation.isActive : null;
    if (port) port.postMessage({ kind, claim, engineActive, ...(extra || {}) });
  };
</script>
<iframe id="tab" src="/tab.html" allow="fullscreen; clipboard-write; autoplay"></iframe>`;

const tabPage = (crossOrigin) => `<!doctype html><meta charset="utf-8"><title>tab</title>
<style>body{margin:0;font:14px system-ui;padding:8px}iframe{width:520px;height:200px;border:1px solid #999}a,input,button{margin:6px}</style>
<a id="link" href="/never.html" target="_blank">open in new tab</a>
<input id="field" placeholder="type here">
<button id="scripted">x</button>
<div><iframe id="nested" src="/nested.html"></iframe><iframe id="cross" src="${crossOrigin}/cross.html"></iframe></div>
<script>
  const claim = () => (navigator.userActivation ? navigator.userActivation.isActive : null);
  const report = (kind, extra) => top[0].__report(kind, claim(), extra);
  window.__reportFromTab = report;
  document.getElementById('link').addEventListener('click', (e) => { e.preventDefault(); report('tab-click', { trusted: e.isTrusted }); });
  document.getElementById('scripted').addEventListener('click', (e) => report('tab-scripted-click', { trusted: e.isTrusted }));
  addEventListener('keydown', (e) => {
    if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') return;
    e.preventDefault();
    report('tab-key', { key: e.key, code: e.code, alt: e.altKey, shift: e.shiftKey, ctrl: e.ctrlKey, trusted: e.isTrusted });
  }, true);
  addEventListener('message', (e) => {
    if (e.data && e.data.crossKind) report(e.data.crossKind, { claimInCross: e.data.claim, trusted: e.data.trusted });
  });
  // Scripted input without any user action, long after the page loaded (anything the harness did has expired).
  setTimeout(() => {
    document.getElementById('scripted').click();
    report('tab-forged', {});
  }, 7000);
  // 6 s after a real click into the field: the click's activation must have expired by then.
  document.getElementById('field').addEventListener('pointerdown', () => setTimeout(() => report('tab-late', {}), 6000), { once: true });
</script>`;

const nestedPage = () => `<!doctype html><meta charset="utf-8"><title>nested</title>
<a id="link" href="/never.html" target="_blank" style="font:14px system-ui">nested link</a>
<input id="field" placeholder="nested field">
<script>
  const claim = () => (navigator.userActivation ? navigator.userActivation.isActive : null);
  document.getElementById('link').addEventListener('click', (e) => { e.preventDefault(); top[0].__report('nested-click', claim(), { trusted: e.isTrusted }); });
  addEventListener('keydown', (e) => {
    if (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') return;
    e.preventDefault();
    top[0].__report('nested-key', claim(), { key: e.key, trusted: e.isTrusted });
  }, true);
</script>`;

const crossPage = () => `<!doctype html><meta charset="utf-8"><title>cross</title>
<a id="link" href="/never.html" target="_blank" style="font:14px system-ui">cross-site link</a>
<script>
  const claim = () => (navigator.userActivation ? navigator.userActivation.isActive : null);
  document.getElementById('link').addEventListener('click', (e) => {
    e.preventDefault();
    parent.postMessage({ crossKind: 'cross-click', claim: claim(), trusted: e.isTrusted }, '*');
  });
</script>`;

const html = (body) => ({ type: 'text/html; charset=utf-8', body });

async function startFixture() {
  const base = portBase();
  const appOrigin = `http://127.0.0.1:${base}`;
  const proxyOrigin = `http://127.0.0.1:${base + 1}`;
  // A different site (localhost vs 127.0.0.1) for the nested cross-site frame.
  const crossOrigin = `http://localhost:${base + 2}`;
  const servers = await Promise.all([
    staticServer('127.0.0.1', base, { '/app.html': html(appPage(proxyOrigin)) }),
    staticServer('127.0.0.1', base + 1, {
      '/engine/': html(enginePage(appOrigin)),
      '/tab.html': html(tabPage(crossOrigin)),
      '/nested.html': html(nestedPage()),
    }),
    staticServer('localhost', base + 2, { '/cross.html': html(crossPage()) }),
  ]);
  return { appOrigin, proxyOrigin, crossOrigin, close: () => Promise.all(servers.map((s) => s.close())) };
}

async function openFixture(context, fx) {
  const page = await context.newPage();
  const log = { ticks: [], records: [], connected: false };
  page.on('console', (m) => {
    const t = m.text();
    if (t === 'GNOME-CONNECTED') log.connected = true;
    else if (t.startsWith('GNOME-TICK ')) log.ticks.push(JSON.parse(t.slice(11)));
    else if (t.startsWith('GNOME-ACT ')) log.records.push(JSON.parse(t.slice(10)));
  });
  await page.goto(`${fx.appOrigin}/app.html`);
  await until(() => log.connected, 15_000, 'connect');
  const frameBy = async (suffix) => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x.url().endsWith(suffix));
      if (f) {
        await f.waitForLoadState('load');
        return f;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`frame ${suffix} not found`);
  };
  const tab = await frameBy('/tab.html');
  const nested = await frameBy('/nested.html');
  const cross = await frameBy('/cross.html');
  return { page, tab, nested, cross, log };
}

async function until(fn, timeout, what) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const nextRecord = (log, kind, timeout = 10_000) => until(() => log.records.find((r) => r.kind === kind), timeout, kind);

/** Page coordinates of an element's centre (read once, before the activation window the suite then waits out). */
async function centre(locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('element not visible');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Waits until the app has reported itself inactive for a while (anything the harness did has expired). */
async function quiet(ctx, log) {
  await ctx.sleep(EXPIRE_MS);
  const last = log.ticks.at(-1);
  return last ?? null;
}

export async function run(ctx) {
  const fx = await startFixture();
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const rec = (test, ok, notes) => ctx.record({ test: `activation: ${test}`, result: ok ? 'pass' : 'fail', notes });

    // Baseline: the API exists and the app page starts without activation.
    {
      const { page, log } = await openFixture(context, fx);
      await until(() => log.ticks.length > 0, 5000, 'tick');
      const a = log.ticks[0];
      rec('navigator.userActivation exists in the app document', a !== null, JSON.stringify(a));
      rec('app document starts without activation', a !== null && a.active === false && a.been === false, JSON.stringify(a));
      await page.close();
    }

    // Real clicks: A. a link in the tab frame (app → engine host → tab frame); B. a nested proxy-origin frame
    // (depth 3); C. a nested cross-site frame (depth 3, another site than both origins).
    for (const [which, kind, label] of [
      ['tab', 'tab-click', 'click in the tab frame activates the app document'],
      ['nested', 'nested-click', 'click in a nested proxy-origin frame activates the app document'],
      ['cross', 'cross-click', 'click in a nested cross-site frame activates the app document'],
    ]) {
      const f = await openFixture(context, fx);
      const at = await centre(f[which].locator('#link'));
      const before = await quiet(ctx, f.log);
      await f.page.mouse.click(at.x, at.y);
      const r = await nextRecord(f.log, kind);
      const claim = which === 'cross' ? r.claimInCross : r.claim;
      rec(label, before?.active === false && r.appActive === true && claim === true && r.trusted === true, JSON.stringify({ before, r }));
      await f.page.close();
    }

    // D/E. Key presses in a frame whose field got the focus by a click long enough ago that its activation expired.
    for (const [which, kind, combo, label] of [
      ['tab', 'tab-key', 'Alt+t', 'Alt+T in the tab frame'],
      ['tab', 'tab-key', 'Alt+Shift+T', 'Alt+Shift+T in the tab frame'],
      ['tab', 'tab-key', 'Control+k', 'Ctrl+K in the tab frame'],
      ['tab', 'tab-key', 'F6', 'F6 in the tab frame'],
      ['tab', 'tab-key', 'k', 'a plain letter in the tab frame'],
      ['nested', 'nested-key', 'Alt+t', 'Alt+T in a nested proxy-origin frame'],
    ]) {
      const f = await openFixture(context, fx);
      const at = await centre(f[which].locator('#field'));
      await f.page.mouse.click(at.x, at.y);
      const before = await quiet(ctx, f.log);
      await f.page.keyboard.press(combo);
      const r = await nextRecord(f.log, kind);
      rec(
        `key press ${label} activates the app document`,
        before?.active === false && r.appActive === true && r.claim === true && r.trusted === true,
        JSON.stringify({ before, r }),
      );
      await f.page.close();
    }

    // F. No gesture: a scripted click and a report without input (both 7 s after load) leave the app inactive.
    {
      const { page, log } = await openFixture(context, fx);
      const r = await nextRecord(log, 'tab-scripted-click', 12_000);
      rec('a scripted click in the tab frame leaves the app document inactive', r.appActive === false && r.claim === false && r.trusted === false, JSON.stringify(r));
      const f = await nextRecord(log, 'tab-forged', 12_000);
      rec('a report without any input leaves the app document inactive', f.appActive === false && f.claim === false, JSON.stringify(f));
      await page.close();
    }

    // G. Activation expires: a report 6 s after a real click finds the app document inactive again.
    {
      const f = await openFixture(context, fx);
      const at = await centre(f.tab.locator('#field'));
      await quiet(ctx, f.log);
      await f.page.mouse.click(at.x, at.y);
      const r = await nextRecord(f.log, 'tab-late', 12_000);
      rec('activation from a frame click expires after 5 s in the app document', r.appActive === false && r.appBeen === true, JSON.stringify(r));
      await f.page.close();
    }

    await context.close();
  } finally {
    await browser.close();
    await fx.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runStandalone('shell-activation', run);
