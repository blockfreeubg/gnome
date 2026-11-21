// Lane a: the WebRTC kill switch on the real stack (ENGINE-PROTOCOL §6.15; WAVE-B §2 Tests and the PROGRESS input
// "WebRTC kill switch"). A proxied page's OWN script (rewritten by its engine) tries RTCPeerConnection against a STUN
// sink on loopback from its window, an about:blank child (contentWindow and window[n]), a srcdoc child and an
// innerHTML-created child, (row `fresh-realms`) srcdoc written after insertion, sandboxed srcdoc and data: frames,
// (row `gaps`) parser-inserted and re-navigated frames, <object>/<embed>, polling a navigating child, javascript:
// and blob: documents, shadow roots, document.write, execCommand and replaceChildren; an SVG document with a script
// does the same. Counted: STUN packets that reach the sink
// directly (outside Wisp, revealing the IP). With `privacy.webrtc: block` the expectation is 0 packets and the
// constructors absent; `allow` is the control (the page reaches the sink). Row `switch`: block → allow → block with
// live settings and reloads (worklist A1).
//
// Parts (`--parts`, all by default): pages (page-and-child-frames), escaped, fresh, gaps, svg, host (engine-host
// realm), switch.
import { fixtureQuery, inFrame, perEngine, readOutOf, startFixtures } from './host-lib.mjs';
import { ALLOW_ALL_PERMISSIONS } from '../lib/drive.mjs';

export async function run(ctx) {
  const want = (part) => !ctx.parts || ctx.parts.includes(part);
  const fx = await startFixtures();
  // Firefox ignores loopback STUN servers unless allowed (the spike's attack suite used the same pref).
  const browser = await ctx.launch({ extraPrefs: { 'media.peerconnection.ice.loopback': true } });
  try {
    for (const policy of ['block', 'allow']) {
      const context = await ctx.newContext(browser);
      try {
        const app = await ctx.openApp(context, fixtureQuery(ctx, { fallback: '0', webrtc: policy }));
        let id = 1;
        if (want('pages')) await perEngine(ctx, `webrtc:${policy}:page-and-child-frames`, async (engine) => {
          const tab = id++;
          fx.stun.reset();
          const a = await app.navigate(tab, `${fx.origin}/webrtc`, { engine, create: true, timeout: 45000 });
          if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
          const out = await readOutOf(app, `tab-${tab}`, 30000);
          await ctx.sleep(1000);
          const packets = fx.stun.packets();
          const realms = out ? Object.entries(out).map(([k, v]) => `${k}=${v}`).join(', ') : 'no result';
          if (policy === 'block') {
            const allAbsent = out && Object.values(out).every((v) => v === 'absent' || v === 'no window');
            return { result: packets === 0 && allAbsent ? 'pass' : 'fail', notes: `STUN packets ${packets}; ${realms}` };
          }
          return { result: packets > 0 && /available/.test(String(out?.page)) ? 'pass' : 'fail', notes: `control (allow): STUN packets ${packets}; ${realms}` };
        });
        if (policy === 'block' && want('escaped')) {
          // Escaped code (unrewritten JS in the proxied document): every realm it can reach or make, including fresh
          // frames of the ENGINE-HOST document (window.top[0]), inserted with that realm's own DOM methods.
          await perEngine(ctx, 'webrtc:block:escaped-code-realms', async (engine) => {
            const tab = id++;
            const a = await app.navigate(tab, `${fx.origin}/`, { engine, create: true, timeout: 45000 });
            if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
            fx.stun.reset();
            const f = app.tabFrame(tab);
            const out = await inFrame(f, async ({ stun }) => {
              const res = {};
              const H = window.top[0];
              const tryRealm = async (k, w) => {
                try {
                  if (!w) return (res[k] = 'no window');
                  if (typeof w.RTCPeerConnection !== 'function') return (res[k] = 'absent');
                  const pc = new w.RTCPeerConnection({ iceServers: [{ urls: stun }] });
                  pc.createDataChannel('x');
                  await pc.setLocalDescription(await pc.createOffer());
                  await new Promise((r) => setTimeout(r, 1200));
                  pc.close();
                  res[k] = 'AVAILABLE';
                } catch (e) {
                  res[k] = `threw ${e.name}`;
                }
              };
              const mk = (doc, how) => {
                if (how === 'innerHTML') {
                  const d = doc.createElement('div');
                  d.innerHTML = '<iframe></iframe>';
                  doc.body.appendChild(d);
                  return d.firstChild.contentWindow;
                }
                const fr = doc.createElement('iframe');
                if (how === 'srcdoc') fr.srcdoc = '<p>x</p>';
                if (how === 'append') doc.body.append(fr);
                else if (how === 'insertAdjacent') doc.body.insertAdjacentElement('beforeend', fr);
                else doc.body.appendChild(fr);
                return fr.contentWindow;
              };
              await tryRealm('page', window);
              await tryRealm('engineHost', H);
              await tryRealm('pageBlankChild', mk(document, 'appendChild'));
              await tryRealm('hostBlankChild', mk(H.document, 'appendChild'));
              await tryRealm('hostAppendChild', mk(H.document, 'append'));
              await tryRealm('hostInsertAdjacent', mk(H.document, 'insertAdjacent'));
              await tryRealm('hostInnerHtmlChild', mk(H.document, 'innerHTML'));
              await tryRealm('hostIndexedChild', (mk(H.document, 'appendChild'), H[H.length - 1]));
              return res;
            }, { stun: fx.stun.url }, 30000);
            await ctx.sleep(1000);
            const packets = fx.stun.packets();
            const ok = packets === 0 && Object.values(out).every((v) => v === 'absent' || v === 'no window');
            return { result: ok ? 'pass' : 'fail', notes: `STUN packets ${packets}; ${Object.entries(out).map(([k, v]) => `${k}=${v}`).join(', ')}` };
          });
        }
        if (policy === 'block' && want('fresh')) {
          // Realms an ordinary page makes itself that no engine hook or child-frame guard reaches in time: a srcdoc
          // written after insertion is a NEW realm in both browsers, data: frames are opaque-origin. Before the fix
          // Ultraviolet leaked through a data: iframe and a srcdoc set later (both browsers), Scramjet through a
          // srcdoc set later (Firefox). Every same-origin realm must still run its own script (`undefined`, not
          // missing), the srcdoc ones included; data: frames load only through an engine that proxies them
          // (Scramjet) and are refused otherwise (FRAME_RESTRICTION_CSP for Ultraviolet).
          await perEngine(ctx, 'webrtc:block:fresh-realms (srcdoc written later, sandbox, data: frames)', async (engine) => {
            const tab = id++;
            fx.stun.reset();
            const a = await app.navigate(tab, `${fx.origin}/webrtc-realms`, { engine, create: true, timeout: 45000 });
            if (!a.ok) return { result: 'fail', notes: `page did not load: ${JSON.stringify(a.error)}` };
            const seen = {};
            const inTab = (fr) => {
              const top = app.tabFrame(tab);
              for (let f = fr; f; f = f.parentFrame()) if (f === top) return true;
              return false;
            };
            for (let i = 0; i < 30; i++) {
              // This tab's frames only (the other engine's tab of this row may still be open).
              for (const fr of app.page.frames().filter(inTab)) {
                const t = await inFrame(fr, () => document.title, undefined, 1500).catch(() => '');
                const m = /^rtc:([a-z-]+):(.*)$/.exec(String(t));
                if (m) seen[m[1]] = m[2];
              }
              if (Object.keys(seen).length >= 7) break;
              await ctx.sleep(500);
            }
            await ctx.sleep(1500);
            const packets = fx.stun.packets();
            const mustRun = ['srcdoc-before-insert', 'sandboxed-srcdoc', 'srcdoc-property-later', 'srcdoc-setattribute-later', 'srcdoc-setattribute-extra-arg', 'srcdoc-attr-value-later', 'srcdoc-innerhtml'];
            const missing = mustRun.filter((k) => !(k in seen));
            const ran = Object.entries(seen).filter(([, v]) => v !== 'undefined');
            const ok = packets === 0 && ran.length === 0 && missing.length === 0;
            await app.cmd('tab.close', { tabId: tab }).catch(() => {});
            return {
              result: ok ? 'pass' : 'fail',
              notes: `STUN packets ${packets}; ${Object.entries(seen).map(([k, v]) => `${k}=${v}`).join(', ')}${missing.length ? `; did not run: ${missing.join(', ')}` : ''}`,
            };
          });
        }
        if (policy === 'block' && want('gaps')) {
          // The gaps the lane-a review found (2026-11-12): frames the parser inserts, frames re-navigated to
          // about:blank, <object>/<embed> documents (all reached through window[n], which no getter wraps), a child
          // polled while it navigates, javascript:/blob: documents, shadow roots, document.write, execCommand,
          // replaceChildren. The page's own script makes and uses each; no constructor may be reachable, no packet
          // may leave.
          // Re-navigation to about:blank: Chromium fires the frame's load in the commit's task (closed), Firefox later
          // (a page polling the frame sees the new realm first: open).
          const renav = ctx.browser === 'firefox' ? 'open' : 'closed';
          const gaps = async (engine, set) => {
            const tab = id++;
            fx.stun.reset();
            const a = await app.navigate(tab, `${fx.origin}/webrtc-gaps?set=${set}&renav=${renav}`, { engine, create: true, timeout: 45000 });
            if (!a.ok) return { ok: false, notes: `page did not load: ${JSON.stringify(a.error)}` };
            const out = await readOutOf(app, `tab-${tab}`, 60000);
            await ctx.sleep(1500);
            const packets = fx.stun.packets();
            await app.cmd('tab.close', { tabId: tab }).catch(() => {});
            if (!out) return { ok: false, notes: `no result; STUN packets ${packets}` };
            const leaks = Object.entries(out).filter(([, v]) => v === 'RAN' || v === 'AVAILABLE');
            return { ok: packets === 0 && leaks.length === 0, notes: `STUN packets ${packets}; ${Object.entries(out).map(([k, v]) => `${k}=${v}`).join(', ')}` };
          };
          await perEngine(ctx, 'webrtc:block:gaps-closed (parser frames, inline onload, document.write, object/embed, shadow root, execCommand, replaceChildren, re-navigation where closed)', async (engine) => {
            const r = await gaps(engine, 'closed');
            return { result: r.ok ? 'pass' : 'fail', notes: r.notes };
          });
          // Known limits of a kill switch in page JavaScript (reported for ENGINE-PROTOCOL §6.15 and About): a page that
          // polls a child frame while it loads a new proxied document reaches that realm before the engine's
          // document-start script has loaded; a javascript: document runs its scripts while it is parsed (Ultraviolet;
          // Scramjet runs none); Firefox re-navigation to about:blank (see above).
          await perEngine(ctx, 'webrtc:block:gaps-open (known limits: polling a navigating frame, javascript:/blob: documents, Firefox about:blank re-navigation)', async (engine) => {
            const r = await gaps(engine, 'open');
            return r.ok ? { result: 'pass', notes: r.notes } : { result: 'fail', expectFail: true, notes: `known limit, reported: ${r.notes}` };
          });
        }
        if (want('svg')) await perEngine(ctx, `webrtc:${policy}:svg-document`, async (engine) => {
          const tab = id++;
          fx.stun.reset();
          const a = await app.navigate(tab, `${fx.origin}/webrtc.svg`, { engine, create: true, timeout: 45000 });
          if (!a.ok) return { result: 'fail', notes: `svg did not load: ${JSON.stringify(a.error)}` };
          let title = null;
          for (let i = 0; i < 40 && (!title || title === 'pending'); i++) {
            const f = app.tabFrame(tab);
            title = f ? await inFrame(f, () => document.querySelector('title')?.textContent ?? null, undefined, 2000).catch(() => null) : null;
            await ctx.sleep(250);
          }
          await ctx.sleep(1500);
          const packets = fx.stun.packets();
          // Neither engine rewrites SVG documents (Scramjet never; Ultraviolet 3.2.10 only text/html), so GNOME forbids
          // their scripts with a second policy, script-src 'none' (lane a's csp.ts for Scramjet, lane b's SW for UV):
          // the script never runs, the title stays "pending" and no STUN packet leaves, whatever privacy.webrtc says.
          return { result: packets === 0 && title === 'pending' ? 'pass' : 'fail', notes: `${policy}: STUN packets ${packets}; svg says ${title} (scripts of unrewritten documents are blocked)` };
        });
        if (policy === 'block' && want('host')) {
          // The engine-host realm itself.
          const host = app.page.frames().find((f) => f.name() === 'engine' || /\/engine\/$/.test(f.url()));
          const t = host ? await inFrame(host, () => typeof window.RTCPeerConnection) : 'no frame';
          ctx.record({ test: 'webrtc:block:engine-host-realm', result: t === 'undefined' ? 'pass' : 'fail', notes: `typeof RTCPeerConnection in the engine host: ${t}` });
        }
        if (policy === 'block' && want('switch')) {
          // The live switch (worklist A1; shell-settings "WebRTC: blocked by default, allowed after the switch"): a
          // `settings` snapshot with `allow` and then the tab's reload give the page's NEW document working WebRTC;
          // `block` and a reload take it away again. The engine-host realm keeps its own guard from the start (its
          // constructors stay undefined), and that guard must follow the live setting: it used to kill every later
          // tab document at its `load`, so `allow` never reached a page once the host had started with `block`.
          await perEngine(ctx, 'webrtc:switch:block → allow → block (settings + tab.reload)', async (engine) => {
            const tab = id++;
            const setPolicy = (v) => app.gnome((w) => window.gnomeTest.applySettings({ privacy: { ...window.gnomeTest.settings.privacy, webrtc: w } }), v);
            // Read through the engine-host document (the tab iframe's window as the engine host reaches it): playwright's
            // Firefox stops answering evaluations in a Scramjet tab frame after its second reload, although the page
            // ran (measured 2026-11-19), and in Chromium Scramjet renames the frame's browsing context.
            const hostRead = () =>
              app.engineFrame().evaluate((n) => {
                const fr = document.querySelector(`iframe[name="tab-${n}"]`);
                const w = fr && fr.contentWindow;
                if (!w) return { out: null, later: 'no frame' };
                let out = null;
                try {
                  out = w.document.getElementById('out')?.textContent ?? null;
                } catch {
                  out = null;
                }
                return { out, later: typeof w.RTCPeerConnection };
              }, tab);
            const probe = async (first) => {
              fx.stun.reset();
              if (first) {
                const a = await app.navigate(tab, `${fx.origin}/webrtc`, { engine, create: true, timeout: 45000 });
                if (!a.ok) throw new Error(`page did not load: ${JSON.stringify(a.error)}`);
              } else {
                const since = await app.mark();
                await app.cmd('tab.reload', { tabId: tab, permissions: ALLOW_ALL_PERMISSIONS });
                const end = await app.waitFor(since, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === tab, 45000);
                if (end?.type !== 'tab.loaded') throw new Error(`reload did not load: ${JSON.stringify(end?.p ?? 'timeout')}`);
              }
              let r = { out: null, later: 'unread' };
              for (let i = 0; i < 150 && (!r.out || r.out === 'pending'); i++) {
                r = await hostRead();
                if (!r.out || r.out === 'pending') await ctx.sleep(200);
              }
              await ctx.sleep(1000);
              // `later` is what shell-settings reads: the constructor as the page has it after its load (the
              // engine-host guard ran at that load), not only what the page's own script saw while it ran.
              const later = (await hostRead()).later;
              const out = r.out && r.out !== 'pending' ? JSON.parse(r.out) : null;
              return { page: String(out?.page ?? 'no result'), all: out ? Object.values(out) : [], later, packets: fx.stun.packets() };
            };
            const blocked = (r) => r.packets === 0 && r.all.length > 0 && r.all.every((v) => v === 'absent' || v === 'no window') && r.later === 'undefined';
            const a = await probe(true);
            await setPolicy('allow');
            const b = await probe(false);
            await setPolicy('block');
            const c = await probe(false);
            await app.cmd('tab.close', { tabId: tab }).catch(() => {});
            const ok = blocked(a) && b.all.length > 0 && b.all.every((v) => /^available/.test(String(v))) && b.later === 'function' && b.packets > 0 && blocked(c);
            const say = (r) => `page=${r.page}, after load typeof=${r.later}, packets ${r.packets}${r.all.length ? '' : ' (no #out)'}`;
            return { result: ok ? 'pass' : 'fail', notes: `block: ${say(a)}; allow: ${say(b)}; block again: ${say(c)}` };
          });
        }
        await app.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await fx.close();
  }
}
