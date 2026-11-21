// Lane b: the transport manager on the real gateway (port of the spike's `transport` suite; WAVE-B §3 "Tests").
// Parts (all by default; `--parts a,b`):
//   engines    every engine × transport loads a page through gnome-server's /wisp/ (the canonical `?t=<ticket>&/`)
//   probe      the probe as the engine host sends it (same-origin GET, no Origin): 426 for its ticket, 401 forged
//   drop       the Wisp socket dropped (the direct HolyWisp restarted): libcurl reconnects by itself, epoxy is probed
//              and rebuilt; the next page loads; plus a gateway restart (gnome-server down for a moment)
//   rejected   a forged ticket and a drop: probe 401 → needTicket{rejected} → a new ticket → the next page loads
//   renewal    the minimum TTL (GNOME_WISP_TICKET_TTL_S=60): needTicket{expiring} at 80 % (≈ 48 s); lazy renewal:
//              libcurl rebuilt, a healthy epoxy kept; pages still load afterwards
//   upstream   VPN profile routes: `e2e-dead` (its HolyWisp never runs) → offline/upstream-unreachable with a backoff
//              and no rebuild loop; `e2e-vpn` stopped and started again → recovers
//   ratelimit  the probe budget used up (60 upgrades + probes per minute per IP): offline/rate-limited with
//              retryInMs from Retry-After, never ticket-rejected; recovers after the wait
//   shared     two GNOME pages (two engine hosts) on UV: one shared transport, a settings change in one, the other
//              with older settings never undoes it, closing the page that installed it and a drop: UV recovers
//   cap        Wisp sockets of this session ≤ GNOME_MAX_WS_PER_SESSION after the steps above (admin diagnostics)
//   custom     custom Wisp servers (route `custom`): without the operator opt-in the policies keep them unreachable and
//              every side says so (never `ready`); with GNOME_ALLOW_CUSTOM_WISP=true a test socket skips a dead first
//              server before any page asks: the direct HolyWisp (no gateway, so no ticket and no probe) serves the
//              first navigation with every engine × transport; a server that dies later fails over and comes back
//   lock       an ordinary UV page (servers/realm-fixtures.mjs `/baremux`, through the VPN profile) connects to
//              bare-mux's SharedWorker and tries to replace the shared transport with a port of its own: refused (the
//              install code's lock); the next UV navigation loads and never reaches the page's port
import { setTimeout as sleep } from 'node:timers/promises';
import { PORTS } from '../lib/config.mjs';
import { startRealmFixtures } from '../servers/realm-fixtures.mjs';

const COMBOS = [
  ['scramjet', 'libcurl'],
  ['scramjet', 'epoxy'],
  ['ultraviolet', 'libcurl'],
  ['ultraviolet', 'epoxy'],
];
const ALL = ['engines', 'probe', 'drop', 'rejected', 'renewal', 'upstream', 'ratelimit', 'shared', 'cap', 'custom', 'lock'];
const SITE_A = { url: 'https://example.com/', title: 'Example Domain' };
const SITE_B = { url: 'https://example.org/', title: 'Example Domain' };
const FORGED = 'w1.4102444800.AAAAAAAAAAAAAAAAAAAAAA.forgedforgedforgedforgedforgedforgedforged0';

/** Waits until the side's TransportStatus satisfies pred; returns it, or {timedOut, last}. */
export async function waitStatus(app, side, pred, timeout = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      last = (await app.status()).transport[side];
      if (pred(last)) return last;
    } catch {
      /* busy */
    }
    await sleep(200);
  }
  return { timedOut: true, last };
}

/** Navigates and judges the transport's part: the tab frame is on the engine's prefix and the site's title arrived. */
async function load(ctx, app, tabId, site, engine, { create = false, timeout = 45000 } = {}) {
  const r = await app.navigate(tabId, site.url, { create, engine, timeout });
  const prefix = engine === 'scramjet' ? ctx.contract.PROXY_PATHS.scramjetPrefix : ctx.contract.PROXY_PATHS.ultravioletPrefix;
  const frameUrl = app.tabFrame(tabId)?.url() ?? '';
  const ok = frameUrl.startsWith(`${ctx.stack.proxyOrigin}${prefix}`) && r.title === site.title;
  const core = `core: ${r.committed ? 'committed' : 'no commit'}, ${r.ok ? 'tab.loaded' : (r.error?.signal ?? r.error?.kind ?? 'no tab.loaded')}`;
  return { ok, r, notes: ok ? `title ${JSON.stringify(r.title)}; ${core}` : `frame ${frameUrl.slice(0, 90)}; ${JSON.stringify(r.error ?? 'no title').slice(0, 200)}; ${core}` };
}

const diag = async (app) => (await app.stats()).transport;

async function withPage(ctx, browser, query, fn) {
  const context = await ctx.newContext(browser);
  try {
    const app = await ctx.openApp(context, query);
    return await fn(app, context);
  } finally {
    await context.close();
  }
}

async function adminWs(ctx) {
  try {
    const d = await (await fetch(`${ctx.stack.adminOrigin}/admin/diagnostics`)).json();
    return d.ws ?? null;
  } catch {
    return null;
  }
}

export async function run(ctx) {
  if (!ctx.engineHost) {
    ctx.record({ test: 'transport suite', result: 'skip', notes: 'engine host not built (frontend/engine/index.html missing)' });
    return;
  }
  if (ctx.offline) {
    ctx.record({ test: 'transport suite', result: 'skip', notes: '--offline: the rows load real sites through HolyWisp' });
    return;
  }
  const parts = new Set(ctx.parts ?? ALL);
  const rec = (test, engine, transport, ok, notes = '', extra = {}) => ctx.record({ test, engine, transport, result: ok ? 'pass' : 'fail', notes, ...extra });
  const browser = await ctx.launch();
  try {
    // ── engines ─────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('engines')) {
      for (const [engine, transport] of COMBOS) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0 }, async (app) => {
            const l = await load(ctx, app, 1, SITE_A, engine, { create: true });
            const st = await app.status();
            rec("loads example.com through /wisp/ (the site's document arrived)", engine, transport, l.ok, `${l.notes}; transport ${st.transport[engine].state}`);
            const rejected = await app.gnome(() => window.gnomeTest.rejected);
            rec('every event and result passed the contract validators', engine, transport, rejected.length === 0, rejected.slice(0, 3).map((x) => `${x.kind}: ${x.error}`).join('; '));
          });
        } catch (e) {
          rec("loads example.com through /wisp/ (the site's document arrived)", engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
    }

    // ── probe ───────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('probe')) {
      await withPage(ctx, browser, {}, async (app) => {
        const ticket = await app.gnome(async () => (await (await fetch('/api/wisp/ticket', { method: 'POST', headers: { 'X-GNOME-Request': '1' } })).json()).ticket);
        const frame = app.engineFrame();
        const probe = (t) =>
          frame.evaluate(async (tk) => {
            const r = await fetch(`/wisp/?t=${encodeURIComponent(tk)}&/`, { cache: 'no-store', credentials: 'omit' });
            let code = null;
            try {
              code = (await r.json()).error?.code ?? null;
            } catch {
              code = null;
            }
            return { status: r.status, code };
          }, t);
        const good = await probe(ticket);
        rec('probe of a valid ticket answers 426 (classifyProbe: valid)', '-', '-', good.status === 426, JSON.stringify(good));
        const bad = await probe(FORGED);
        rec('probe of a forged ticket answers 401 wisp_ticket_* (classifyProbe: rejected)', '-', '-', bad.status === 401 && /^wisp_ticket_/.test(bad.code ?? ''), JSON.stringify(bad));
        const profile = await frame.evaluate(async (tk) => (await fetch(`/wisp/p/no-such-profile/?t=${encodeURIComponent(tk)}&/`, { cache: 'no-store', credentials: 'omit' })).status, ticket);
        rec('probe of an unknown VPN profile answers 404 (classifyProbe: unknown-profile)', '-', '-', profile === 404, String(profile));
      });
    }

    // ── drop ────────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('drop')) {
      for (const [engine, transport] of COMBOS) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0 }, async (app) => {
            const first = await load(ctx, app, 1, SITE_A, engine, { create: true });
            if (!first.ok) {
              rec('drop: first page', engine, transport, false, first.notes);
              return;
            }
            const before = await diag(app);
            const up = ctx.stack.upstream('direct');
            await up.stop();
            const down = await waitStatus(app, engine, (s) => s.state !== 'ready', 15000);
            await up.start();
            const after = await load(ctx, app, 1, SITE_B, engine);
            const d = await diag(app);
            const st = (await app.status()).transport[engine];
            const rebuilt = d.rebuilds[engine] - before.rebuilds[engine];
            const kindOk = transport === 'epoxy' ? rebuilt >= 1 : true;
            rec(
              'drop: the socket close is seen, the next page loads',
              engine,
              transport,
              after.ok && d.drops[engine] > before.drops[engine] && kindOk && st.state === 'ready',
              `seen: ${down.timedOut ? 'no state change' : `${down.state}/${down.detail}`}; drops +${d.drops[engine] - before.drops[engine]}, rebuilds +${rebuilt}, probes ${JSON.stringify(d.probes)}; after: ${st.state}; ${after.notes}`,
            );
          });
        } catch (e) {
          rec('drop: the socket close is seen, the next page loads', engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
      // gateway restart: gnome-server itself goes away for a moment (probe fails at the network level → backoff)
      for (const [engine, transport] of [['scramjet', 'epoxy'], ['ultraviolet', 'libcurl']]) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0 }, async (app) => {
            const first = await load(ctx, app, 1, SITE_A, engine, { create: true });
            const t0 = Date.now();
            await ctx.stack.restartServer({});
            // A navigation started during the outage fails and is not retried (spike §6): wait for the side first.
            const back = await waitStatus(app, engine, (s) => s.state === 'ready', 40000);
            const after = await load(ctx, app, 1, SITE_B, engine, { timeout: 60000 });
            const d = await diag(app);
            rec('gateway restart: recovers, the next page loads', engine, transport, first.ok && after.ok, `ready again: ${back.timedOut ? `no (last ${JSON.stringify(back.last)})` : 'yes'}; restart+load ${Date.now() - t0} ms; probes ${JSON.stringify(d.probes)}; ${after.notes}`);
          });
        } catch (e) {
          rec('gateway restart: recovers, the next page loads', engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
    }

    // ── rejected ────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('rejected')) {
      for (const [engine, transport] of [['scramjet', 'libcurl'], ['scramjet', 'epoxy'], ['ultraviolet', 'epoxy']]) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0 }, async (app) => {
            await load(ctx, app, 1, SITE_A, engine, { create: true });
            const mark = await app.mark();
            const before = await app.gnome(() => window.gnomeTest.ticketRequests);
            await app.gnome((t) => window.gnomeTest.sendTicket(t), FORGED);
            // Force the next upgrade (libcurl was rebuilt with the forged ticket; epoxy kept its socket and needs a drop).
            const up = ctx.stack.upstream('direct');
            await up.stop();
            await sleep(300);
            await up.start();
            // libcurl reconnects only on a request: one navigation that may fail, then the renewal must have happened.
            await app.navigate(1, SITE_B.url, { engine, timeout: 20000 });
            const need = await app.waitFor(mark, (e) => e.type === 'needTicket' && e.p.reason === 'rejected', 20000);
            await sleep(2500);
            const after = await load(ctx, app, 1, SITE_A, engine);
            const minted = (await app.gnome(() => window.gnomeTest.ticketRequests)) - before;
            const d = await diag(app);
            rec('forged ticket: probe 401 → needTicket{rejected} → new ticket → loads', engine, transport, !!need && minted >= 1 && after.ok, `needTicket ${need ? 'rejected' : 'missing'}; minted ${minted}; probes ${JSON.stringify(d.probes)}; ${after.notes}`);
          });
        } catch (e) {
          rec('forged ticket: probe 401 → needTicket{rejected} → new ticket → loads', engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
    }

    // ── renewal ─────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('renewal')) {
      await ctx.stack.restartServer({ GNOME_WISP_TICKET_TTL_S: '60' });
      try {
        await Promise.all(
          ['libcurl', 'epoxy'].map((transport) =>
            withPage(ctx, browser, { transport, fallback: 0 }, async (app) => {
              const first = await load(ctx, app, 1, SITE_A, 'scramjet', { create: true, engine: 'scramjet' });
              const t0 = await app.gnome(() => window.gnomeTest.tickets[0]?.at ?? Date.now());
              const before = await diag(app);
              const mark = await app.mark();
              const ev = await app.waitFor(mark, (e) => e.type === 'needTicket' && e.p.reason === 'expiring', 70000);
              const at = ev ? ev.t - t0 : null;
              await sleep(3000); // the driver mints and sends the ticket
              const after = await diag(app);
              const second = await load(ctx, app, 1, SITE_B, 'scramjet');
              const rebuilt = after.rebuilds.scramjet - before.rebuilds.scramjet;
              const lazyOk = transport === 'libcurl' ? rebuilt >= 1 : rebuilt === 0;
              rec(
                'TTL 60 s: needTicket{expiring} at 80 % of the life; lazy renewal per kind; pages load',
                'scramjet',
                transport,
                first.ok && at !== null && at >= 40_000 && at <= 52_000 && lazyOk && second.ok,
                `expiring after ${at} ms (expected ≈ 47-48 s); scramjet rebuilds +${rebuilt} (${transport === 'libcurl' ? 'expected ≥ 1' : 'expected 0: a healthy epoxy keeps its socket'}); ${second.notes}`,
              );
            }),
          ),
        );
      } catch (e) {
        rec('TTL 60 s: needTicket{expiring} at 80 % of the life; lazy renewal per kind; pages load', 'scramjet', '-', false, String(e.message || e).slice(0, 300));
      } finally {
        await ctx.stack.restartServer({});
      }
    }

    // ── upstream ────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('upstream')) {
      for (const [engine, transport] of COMBOS) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0, route: `profile:${ctx.stack.profiles.dead}` }, async (app) => {
            const r = await app.navigate(1, SITE_A.url, { create: true, engine, timeout: 20000 });
            const st = await waitStatus(app, engine, (s) => s.state === 'offline' && s.detail === 'upstream-unreachable', 20000);
            const d1 = await diag(app);
            await sleep(6000);
            const d2 = await diag(app);
            const growth = d2.rebuilds[engine] - d1.rebuilds[engine];
            rec(
              'VPN profile whose HolyWisp is down: offline/upstream-unreachable with a backoff, no rebuild loop',
              engine,
              transport,
              !st.timedOut && typeof st.retryInMs === 'number' && st.retryInMs > 0 && growth <= 2 && !r.ok,
              st.timedOut ? `last ${JSON.stringify(st.last)}` : `retryInMs ${st.retryInMs}; probes ${JSON.stringify(d2.probes)}; rebuilds in 6 s +${growth}`,
            );
          });
        } catch (e) {
          rec('VPN profile whose HolyWisp is down: offline/upstream-unreachable with a backoff, no rebuild loop', engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
      for (const [engine, transport] of [['scramjet', 'epoxy'], ['ultraviolet', 'libcurl']]) {
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0, route: `profile:${ctx.stack.profiles.live}` }, async (app) => {
            const first = await load(ctx, app, 1, SITE_A, engine, { create: true });
            const up = ctx.stack.upstream(ctx.stack.profiles.live);
            await up.stop();
            await app.navigate(1, SITE_B.url, { engine, timeout: 15000 });
            const st = await waitStatus(app, engine, (s) => s.state === 'offline' && s.detail === 'upstream-unreachable', 20000);
            await up.start();
            // The next probe comes after the backoff; a navigation reports the failure and probes sooner.
            let after = null;
            for (let i = 0; i < 6 && !after?.ok; i++) {
              await sleep(2500);
              after = await load(ctx, app, 1, i % 2 ? SITE_A : SITE_B, engine, { timeout: 20000 });
            }
            rec(
              'VPN profile upstream stopped and started: upstream-unreachable, then recovers',
              engine,
              transport,
              first.ok && !st.timedOut && !!after?.ok,
              // The first load is named too: a failure there (e.g. an intermittent TLS error of the transport) is not a
              // recovery bug (quality review, integration part 2).
              `first load ${first.ok ? 'ok' : `FAILED: ${first.notes}`}; ${st.timedOut ? `no upstream-unreachable (last ${JSON.stringify(st.last)})` : `upstream-unreachable, retryInMs ${st.retryInMs}`}; ${after?.notes}`,
            );
          });
        } catch (e) {
          rec('VPN profile upstream stopped and started: upstream-unreachable, then recovers', engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
    }

    // ── ratelimit ───────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('ratelimit')) {
      try {
        await withPage(ctx, browser, { engine: 'scramjet', transport: 'epoxy', fallback: 0 }, async (app) => {
          const first = await load(ctx, app, 1, SITE_A, 'scramjet', { create: true });
          // Use up the per-IP upgrade budget (probes count against it) from this host: same IP as the browser.
          let limited = 0;
          for (let i = 0; i < 90 && limited < 3; i++) {
            const r = await fetch(`${ctx.stack.proxyOrigin}/wisp/?t=${FORGED}&/`, { cache: 'no-store' });
            await r.arrayBuffer();
            if (r.status === 429) limited += 1;
          }
          const up = ctx.stack.upstream('direct');
          await up.stop();
          await up.start();
          const st = await waitStatus(app, 'scramjet', (s) => s.detail === 'rate-limited', 20000);
          const tickets = await app.gnome(() => window.gnomeTest.events.filter((e) => e.type === 'needTicket' && e.p.reason === 'rejected').length);
          rec(
            'probe 429: offline/rate-limited with retryInMs from Retry-After, never ticket-rejected',
            'scramjet',
            'epoxy',
            first.ok && limited > 0 && !st.timedOut && (st.retryInMs ?? 0) >= 1000 && tickets === 0,
            `429s while burning: ${limited}; ${st.timedOut ? `last ${JSON.stringify(st.last)}` : `retryInMs ${st.retryInMs}`}; needTicket{rejected} ${tickets}`,
          );
          if (!st.timedOut) {
            await sleep(Math.min(70_000, (st.retryInMs ?? 0) + 3000));
            const after = await load(ctx, app, 1, SITE_B, 'scramjet', { timeout: 30000 });
            rec('after the Retry-After wait the side recovers', 'scramjet', 'epoxy', after.ok, after.notes);
          }
        });
      } catch (e) {
        rec('probe 429: offline/rate-limited with retryInMs from Retry-After, never ticket-rejected', 'scramjet', 'epoxy', false, String(e.message || e).slice(0, 300));
      }
      await sleep(5000);
    }

    // ── shared ──────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('shared')) {
      const context = await ctx.newContext(browser);
      try {
        const a = await ctx.openApp(context, { engine: 'ultraviolet', transport: 'libcurl', fallback: 0 });
        const b = await ctx.openApp(context, { engine: 'ultraviolet', transport: 'libcurl', fallback: 0 });
        const la = await load(ctx, a, 1, SITE_A, 'ultraviolet', { create: true });
        const lb = await load(ctx, b, 1, SITE_B, 'ultraviolet', { create: true });
        const name = async (app) => app.engineFrame().evaluate(() => new window.BareMux.BareMuxConnection('/vendor/bare-mux/worker.js').getTransport());
        const n1 = await name(a);
        rec('two engine hosts share one UV transport (both pages load; one name)', 'ultraviolet', 'libcurl', la.ok && lb.ok && n1 === (await name(b)) && /^gnome:\d+:libcurl\|default\|$/.test(n1), `${n1}; a: ${la.notes}; b: ${lb.notes}`);
        // B's app changes the transport kind: B installs epoxy. A (older settings) reports a failure: it keeps B's.
        await b.gnome(() => window.gnomeTest.applySettings({ transport: 'epoxy' }));
        const n2 = await name(b);
        await a.cmd('tab.navigate', { tabId: 1, url: SITE_B.url, engine: 'ultraviolet', permissions: { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' } }).catch(() => null);
        await sleep(3000);
        const n3 = await name(a);
        rec('a settings change in one GNOME page installs its transport; the other never undoes it', 'ultraviolet', 'epoxy', /\|?epoxy\|default\|$/.test(n2) && n3 === n2, `after B: ${n2}; after A's navigation: ${n3}`);
        // The app syncs settings: A gets the same snapshot (keep, no reinstall). Then B, which installed it, closes.
        await a.gnome(() => window.gnomeTest.applySettings({ transport: 'epoxy' }));
        const n4 = await name(a);
        await b.close();
        const up = ctx.stack.upstream('direct');
        await up.stop();
        await sleep(500);
        await up.start();
        let after = null;
        for (let i = 0; i < 4 && !after?.ok; i++) {
          await sleep(1500);
          after = await load(ctx, a, 1, i % 2 ? SITE_B : SITE_A, 'ultraviolet', { timeout: 25000 });
        }
        const d = await diag(a);
        rec('after the installing page closed and a drop, UV recovers in the other page', 'ultraviolet', 'epoxy', n4 === n2 && !!after?.ok, `kept ${n4}; drops ${d.drops.ultraviolet}, rebuilds ${d.rebuilds.ultraviolet}; ${after?.notes}`);
        await a.close();
      } catch (e) {
        rec('two engine hosts share one UV transport', 'ultraviolet', '-', false, String(e.message || e).slice(0, 300));
      } finally {
        await context.close();
      }
    }

    // ── cap ─────────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('cap')) {
      const ws = await adminWs(ctx);
      const per = ws?.limits?.per_session ?? 16;
      await withPage(ctx, browser, { engine: 'scramjet', transport: 'epoxy', fallback: 0 }, async (app) => {
        await load(ctx, app, 1, SITE_A, 'scramjet', { create: true });
        for (let i = 0; i < 3; i++) await app.gnome(() => window.gnomeTest.renewNow());
        await load(ctx, app, 1, SITE_B, 'scramjet');
        const now = await adminWs(ctx);
        rec('Wisp sockets stay under the per-session cap after renewals (lazy renewal keeps epoxy)', 'scramjet', 'epoxy', !!now && now.active <= per, `active ${now?.active}, per-session cap ${per}`);
      });
    }

    // ── custom ───────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('custom')) {
      // The runner's direct HolyWisp stands in for a user's own Wisp server (loopback, no auth); the dead profile's
      // port is never bound.
      const route = `custom:ws://127.0.0.1:${PORTS.dead}/,ws://127.0.0.1:${PORTS.holywisp}/`;
      // Without the opt-in the policies refuse both servers (engine host and bare-mux worker: connect-src 'self';
      // Firefox throws from the WebSocket constructor, Chromium fires `error` without `close`). Every side must say
      // so, never `ready` while nothing can load (worklist A2: UV stayed `ready`), and nothing loads.
      for (const [engine, transport] of COMBOS) {
        const test = 'custom Wisp servers without the operator opt-in: unreachable, the side never says ready, nothing loads';
        try {
          await withPage(ctx, browser, { engine, transport, fallback: 0, route }, async (app) => {
            const states = new Set();
            const sample = async (ms) => {
              const end = Date.now() + ms;
              while (Date.now() < end) {
                const st = (await app.status()).transport[engine];
                states.add(`${st.state}/${st.detail ?? '-'}`);
                await sleep(100);
              }
            };
            await sample(1500);
            const r = await app.navigate(1, SITE_A.url, { create: true, engine, timeout: 20000 });
            await sample(3000);
            const st = (await app.status()).transport[engine];
            rec(
              test,
              engine,
              transport,
              !r.ok && st.endpoint === 'custom' && !states.has('ready/-') && [...states].some((x) => x === 'offline/gateway-unreachable'),
              `${r.ok ? 'LOADED' : `not loaded (${r.error?.kind ?? r.error})`}; states seen ${[...states].join(' ')}`,
            );
          });
        } catch (e) {
          rec(test, engine, transport, false, String(e.message || e).slice(0, 300));
        }
      }
      await ctx.stack.restartServer({ GNOME_ALLOW_CUSTOM_WISP: 'true' });
      try {
        for (const [engine, transport] of COMBOS) {
          const test = 'custom Wisp servers with the opt-in: a test socket skips a dead first server before any page asks; no probe; pages load';
          try {
            await withPage(ctx, browser, { engine, transport, fallback: 0, route }, async (app) => {
              // Worklist A3: the transport is built for the first server whose test socket opens, so the very first
              // navigation already loads through the second server and the dead one was never built.
              const first = await load(ctx, app, 1, SITE_A, engine, { create: true, timeout: 45000 });
              const st = (await app.status()).transport[engine];
              const d = await diag(app);
              const probes = Object.values(d.probes).reduce((a, b) => a + b, 0);
              rec(
                test,
                engine,
                transport,
                first.ok && st.state === 'ready' && st.endpoint === 'custom' && probes === 0 && d.rebuilds[engine] === 0,
                `first navigation ${first.ok ? 'loaded' : 'FAILED'}; ${st.state}/${st.endpoint}; rebuilds ${d.rebuilds[engine]}; probes ${probes}; ${first.notes}`,
              );
            });
          } catch (e) {
            rec(test, engine, transport, false, String(e.message || e).slice(0, 300));
          }
        }
        // A server that dies later: its transport's own socket fails, the side fails over to the next server that
        // opens a test socket (here the same server is the only live one: it comes back after the dead one's test).
        try {
          const [engine, transport] = ['ultraviolet', 'epoxy'];
          await withPage(ctx, browser, { engine, transport, fallback: 0, route }, async (app) => {
            const a = await load(ctx, app, 1, SITE_A, engine, { create: true, timeout: 45000 });
            await ctx.stack.upstream('direct').stop();
            const b = await app.navigate(1, SITE_B.url, { engine, timeout: 20000 });
            const off = await waitStatus(app, engine, (x) => x.state === 'offline' && x.detail === 'gateway-unreachable', 15000);
            await ctx.stack.upstream('direct').start();
            const back = await waitStatus(app, engine, (x) => x.state === 'ready', 45000);
            const c = back.timedOut ? { ok: false, notes: 'never ready' } : await load(ctx, app, 1, SITE_B, engine, { timeout: 45000 });
            rec(
              'custom Wisp server that dies later: offline/gateway-unreachable, back to ready when it returns, pages load',
              engine,
              transport,
              a.ok && !b.ok && !off.timedOut && !back.timedOut && c.ok,
              `before ${a.ok}; while down ${b.ok ? 'LOADED' : 'failed'}, ${off.timedOut ? `never offline: ${JSON.stringify(off.last)}` : 'offline/gateway-unreachable'}; ${back.timedOut ? 'never ready again' : 'ready again'}; after ${c.notes}`,
            );
          });
        } catch (e) {
          rec('custom Wisp server that dies later: offline/gateway-unreachable, back to ready when it returns, pages load', 'ultraviolet', 'epoxy', false, String(e.message || e).slice(0, 300));
          await ctx.stack.upstream('direct').start().catch(() => {});
        }
      } finally {
        await ctx.stack.restartServer({});
      }
    }

    // ── lock ─────────────────────────────────────────────────────────────────────────────────────────────────────
    if (parts.has('lock')) {
      const fx = await startRealmFixtures(PORTS.realm);
      try {
        for (const transport of ['libcurl', 'epoxy']) {
          await withPage(ctx, browser, { engine: 'ultraviolet', transport, fallback: 0, route: `profile:${ctx.stack.profiles.live}` }, async (app) => {
            const attacker = await app.navigate(1, `${fx.origin}/baremux`, { create: true, engine: 'ultraviolet', timeout: 30000 });
            let report = null;
            for (let i = 0; i < 20 && !(report && report.set !== null); i++) {
              await sleep(250);
              const raw = await app.tabFrame(1)?.evaluate(() => document.getElementById('out')?.textContent ?? null).catch(() => null);
              try {
                report = raw ? JSON.parse(raw) : null;
              } catch {
                report = null;
              }
            }
            const victim = await app.navigate(2, `${fx.origin}/plain?victim=1`, { create: true, engine: 'ultraviolet', timeout: 30000 });
            await sleep(1000);
            const raw = await app.tabFrame(1)?.evaluate(() => document.getElementById('out')?.textContent ?? null).catch(() => null);
            try {
              report = raw ? JSON.parse(raw) : report;
            } catch {
              /* keep the last report */
            }
            const stolen = (report?.intercepted ?? []).filter((u) => /victim=1/.test(u));
            rec(
              'an ordinary UV page cannot replace the shared bare-mux transport (the lock); the next UV page loads past it',
              'ultraviolet',
              transport,
              attacker.ok && /^refused/.test(String(report?.set)) && stolen.length === 0 && victim.ok,
              `page: get ${JSON.stringify(report?.get)}, set ${JSON.stringify(report?.set)}, intercepted ${report?.intercepted?.length ?? '?'}; victim ${victim.ok ? 'loaded' : JSON.stringify(victim.error).slice(0, 120)}`,
            );
          });
        }
      } finally {
        await fx.close();
      }
    }
  } finally {
    await browser.close();
  }
}
