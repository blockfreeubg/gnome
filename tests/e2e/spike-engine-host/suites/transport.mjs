// Item 5 (spike-transport-fallback): Wisp tickets and reconnect behaviour of all four transports
// (Scramjet: libcurl-transport 2.0.6, epoxy-transport 3.0.2; UV via bare-mux 2.1.9: epoxy-transport 2.1.29,
// libcurl-transport 1.5.2) behind the gateway stub, and the engine host's recovery recipe.
//
// The suite forces the gateway stub's STRICT ticket parsing (SPIKE_GATEWAY_STRICT=1, identical to the session-4
// backend/src/gateway ticket_param; also the stub's default now) for its whole run and restores the setting afterwards.
// Every navigation goes to the local target through /wisp/p/test-loopback/ (route=test), so results do not
// depend on the internet.
import { TARGET_ORIGIN, TICKETS } from '../lib/config.mjs';

// One engine host runs one Scramjet and one UV transport at a time; two pairings cover all four transports.
const PAIRS = [
  { sjt: 'libcurl', uvt: 'epoxy' },
  { sjt: 'epoxy', uvt: 'libcurl' },
];
const SIDES = [
  { tab: 1, engine: 'scramjet', key: 'sjt' },
  { tab: 2, engine: 'ultraviolet', key: 'uvt' },
];
const tail = (t) => t.slice(-6);
let navN = 0;
const dest = (tag) => `${TARGET_ORIGIN}/?transport=${tag}&n=${++navN}`;

function upgradesSince(ctx, t) {
  return ctx.events.filter((e) => e.from === 'proxy' && e.type === 'wisp-upgrade' && e.at >= t);
}
function summarize(ups) {
  const by = {};
  for (const u of ups) {
    const k = `${u.status}:${u.ticketForm}${u.ticketTail ? `:${u.ticketTail}` : ''}`;
    by[k] = (by[k] || 0) + 1;
  }
  return by;
}
async function wispSince(app, t, side) {
  const s = await app.stats();
  return s.counters.wisp.filter((w) => w.t >= t && (!side || w.side === side));
}
async function recoveriesSince(app, t) {
  return (await app.stats()).counters.recoveries.filter((r) => r.t >= t);
}
async function waitUntil(fn, timeout, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}
// A "loaded" event is not enough (an engine error page also loads): the target must have served the request and
// the tab's title must be the target's. (Reading the proxied frame with Playwright hangs in Firefox after
// location.replace() navigations, so the check uses the harness event logs instead.)
let CTX = null;
async function go(app, tab, engine, url, opts = {}) {
  const since = Date.now();
  const r = await app.navigate(tab, url, { engine, ...opts });
  if (r.ok) {
    const served = CTX.events.some((e) => e.from === 'target' && e.type === 'target-request' && e.path === new URL(url).pathname && e.at >= since);
    const title = await app.gnome((t) => window.gnomeTest.events.filter((e) => e.type === 'tab.title' && e.p.tabId === t).pop()?.p.title ?? null, tab);
    if (!served || title !== 'GNOME spike target') Object.assign(r, { ok: false, error: `loaded a non-target page (target hit ${served}, title ${JSON.stringify(title)})` });
  }
  return r;
}
const navNote = (r) => (r.ok ? `ok ${r.ms} ms` : `FAILED (${typeof r.error === 'string' ? r.error : `${r.error?.kind}/${r.error?.signal}: ${String(r.error?.detail).slice(0, 120)}`})`);

// Every Playwright call into the page gets a deadline, so a stuck browser becomes a failed row, not a hung run.
const tmo = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer from the page within ${ms} ms (${label})`)), ms))]);
function harden(app, log) {
  for (const [k, ms] of [['gnome', 10000], ['cmd', 40000], ['stats', 10000], ['mark', 10000], ['eventsSince', 10000]]) {
    const f = app[k].bind(app);
    app[k] = (...a) => { if (log) log(`-> ${k} ${typeof a[0] === 'string' ? a[0] : ''}`); return tmo(f(...a), ms, k); };
  }
  return app;
}

async function openPair(ctx, browser, pair, extra = {}) {
  const context = await ctx.newContext(browser);
  const app = harden(await ctx.openApp(context, { sjt: pair.sjt, uvt: pair.uvt, route: 'test', ticketForm: 'query+amp-slash', fallback: '0', navTimeout: '8000', ...extra }), process.env.SPIKE_TRACE ? ctx.log : null);
  return { context, app };
}

async function navBoth(app, tag, { create = false, timeout = 15000 } = {}) {
  const out = {};
  for (const s of SIDES) out[s.engine] = await go(app, s.tab, s.engine, dest(tag), { create, timeout });
  return out;
}

export async function run(ctx) {
  CTX = ctx;
  const prevStrict = process.env.SPIKE_GATEWAY_STRICT;
  process.env.SPIKE_GATEWAY_STRICT = '1';
  await ctx.restartProxy(200);
  const browser = await ctx.launch();
  try {
    await ticketForms(ctx, browser);
    for (const pair of PAIRS) {
      await rawDrop(ctx, browser, pair);
      await recipe(ctx, browser, pair);
    }
    await rustProbeOrder(ctx, browser);
  } finally {
    await browser.close();
    await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.first] }).catch(() => {});
    await ctx.command('app', 'setTicket', { ticket: TICKETS.first }).catch(() => {});
    if (prevStrict === undefined) delete process.env.SPIKE_GATEWAY_STRICT;
    else process.env.SPIKE_GATEWAY_STRICT = prevStrict;
    await ctx.restartProxy(200);
  }
}

// Which ticket URL forms each transport accepts, against the strict (Rust-identical) gateway.
async function ticketForms(ctx, browser) {
  const forms = [
    { form: 'query', url: '?t=<ticket>' },
    { form: 'query+slash', url: '?t=<ticket>/' },
    { form: 'query+amp-slash', url: '?t=<ticket>&/' },
  ];
  for (const pair of PAIRS) {
    for (const f of forms) {
      const t0 = Date.now();
      const context = await ctx.newContext(browser);
      let app;
      try {
        app = harden(await ctx.openApp(context, { sjt: pair.sjt, uvt: pair.uvt, route: 'test', ticketForm: f.form, fallback: '0', navTimeout: '6000', watchdog: '0' }));
        for (const s of SIDES) {
          const kind = pair[s.key];
          const eng = app.init.engines[s.engine];
          let r = null;
          if (eng.state === 'ready') r = await go(app, s.tab, s.engine, dest(`form-${f.form}`), { create: true, timeout: 12000 });
          const ws = (await wispSince(app, t0, s.engine)).map((w) => `${w.ev}${w.code ? `(${w.code})` : ''}`);
          const ok = !!r?.ok;
          // The only documented failure: libcurl (1.x/2.x) refuses a Wisp URL that does not end with "/" (upstream).
          // Against the session-4 gateway parse every other form/transport pair must work, so --strict catches it.
          const known = f.form === 'query' && kind === 'libcurl';
          ctx.record({
            engine: s.engine,
            transport: kind,
            test: `ticket-form ${f.url}`,
            result: ok ? 'pass' : 'fail',
            expectFail: !ok && known,
            notes: eng.state !== 'ready' ? `engine ${eng.state}: ${eng.detail}` : `${navNote(r)}; sockets ${ws.join(',')}`,
            data: { form: f.form, engineState: eng.state, detail: eng.detail, nav: r && { ok: r.ok, ms: r.ms, error: r.error } },
          });
        }
        ctx.log(`forms ${pair.sjt}/${pair.uvt} ${f.form}: upgrades ${JSON.stringify(summarize(upgradesSince(ctx, t0)))}`);
      } catch (e) {
        ctx.record({ engine: 'both', transport: `${pair.sjt}/${pair.uvt}`, test: `ticket-form ${f.url}`, result: 'fail', notes: `init: ${String(e.message || e).slice(0, 200)}` });
      } finally {
        await tmo(context.close(), 15000, 'context.close').catch((e) => ctx.log(e.message));
      }
    }
  }
}

// What each transport does by itself after the gateway drops its socket (watchdog off).
async function rawDrop(ctx, browser, pair) {
  const { context, app } = await openPair(ctx, browser, pair, { watchdog: '0' });
  try {
    const t0 = Date.now();
    const first = await navBoth(app, 'raw-initial', { create: true });
    const initUps = upgradesSince(ctx, t0);
    for (const s of SIDES) {
      const r = first[s.engine];
      ctx.record({ engine: s.engine, transport: pair[s.key], test: 'initial connect carries ?t=', result: r.ok && initUps.length && initUps.every((u) => u.status === 101 && u.ticketForm === 'query+amp-slash') ? 'pass' : 'fail', notes: `${navNote(r)}; upgrades ${JSON.stringify(summarize(initUps))}` });
    }
    const tDrop = Date.now();
    const dropped = await ctx.command('proxy', 'dropWisp');
    await ctx.sleep(500);
    const after = await navBoth(app, 'raw-after-drop');
    const ups = upgradesSince(ctx, tDrop);
    for (const s of SIDES) {
      const kind = pair[s.key];
      const ws = await wispSince(app, tDrop, s.engine);
      const reconnects = ws.filter((w) => w.ev === 'connecting');
      const r = after[s.engine];
      ctx.record({
        engine: s.engine,
        transport: kind,
        test: 'drop: transport reconnects by itself (watchdog off)',
        result: r.ok && reconnects.length ? 'pass' : 'fail',
        expectFail: kind === 'epoxy' && !r.ok, // epoxy 2.1.29/3.0.2 never reconnect (upstream); libcurl must
        notes: `${navNote(r)}; new sockets after drop: ${reconnects.length} (${reconnects.map((w) => w.url.replace(/^.*\?/, '?')).join(' ')}); dropped ${dropped.dropped}`,
        data: { reconnects: reconnects.length, ws, nav: { ok: r.ok, ms: r.ms, error: r.error } },
      });
    }
    ctx.log(`raw drop ${pair.sjt}/${pair.uvt}: upgrades after drop ${JSON.stringify(summarize(ups))}`);
    // A transport that did not come back: re-set it (new instance, same ticket) and retry.
    for (const s of SIDES) {
      if (after[s.engine].ok) continue;
      const t1 = Date.now();
      await app.cmd('test.recreateTransport', { engine: s.engine }, 20000);
      const ms = Date.now() - t1;
      const r = await go(app, s.tab, s.engine, dest('raw-recreated'), { timeout: 15000 });
      ctx.record({ engine: s.engine, transport: pair[s.key], test: 'drop: recreate transport (same ticket) restores it', result: r.ok ? 'pass' : 'fail', notes: `recreate ${ms} ms; ${navNote(r)}` });
    }
  } finally {
    await tmo(context.close(), 15000, 'context.close').catch((e) => ctx.log(e.message));
  }
}

// The engine host's recipe (watchdog on, dropProbe on): drop, gateway kill + restart, ticket rotation,
// proactive renewal.
async function recipe(ctx, browser, pair) {
  const { context, app } = await openPair(ctx, browser, pair, { watchdog: '1' });
  try {
    await app.cmd('settings', { dropProbe: true });
    const first = await navBoth(app, 'recipe-initial', { create: true });
    if (!first.scramjet.ok || !first.ultraviolet.ok) throw new Error(`initial navigation failed: ${JSON.stringify({ sj: first.scramjet.error, uv: first.ultraviolet.error })}`);
    const liveBase = (await ctx.command('proxy', 'stats')).live;
    const liveLog = [`start:${liveBase}`];
    const noteLive = async (step) => { await ctx.sleep(300); liveLog.push(`${step}:${(await ctx.command('proxy', 'stats')).live}`); };

    // 1. Gateway drops every Wisp socket.
    ctx.log('step: 1. Gateway drops');
    {
      const t0 = Date.now();
      await ctx.command('proxy', 'dropWisp');
      // epoxy is recreated by the watchdog; libcurl reconnects lazily on the next request.
      const rec = await waitUntil(async () => {
        const rs = await recoveriesSince(app, t0);
        const need = SIDES.filter((s) => pair[s.key] === 'epoxy').map((s) => s.engine);
        return need.every((e) => rs.some((r) => r.side === e)) ? rs : null;
      }, 10000);
      const recovered = rec ? Object.fromEntries(rec.map((r) => [r.side, r.t - t0])) : null;
      const after = await navBoth(app, 'recipe-drop');
      const ups = upgradesSince(ctx, t0);
      for (const s of SIDES) {
        const r = after[s.engine];
        ctx.record({
          engine: s.engine, transport: pair[s.key], test: 'recipe: gateway drop -> recovered',
          result: r.ok ? 'pass' : 'fail',
          notes: `${navNote(r)}; ${pair[s.key] === 'epoxy' ? `watchdog recreated transport ${recovered?.[s.engine] ?? '?'} ms after drop` : 'libcurl reconnected on next request'}; upgrades ${JSON.stringify(summarize(ups))}`,
        });
      }
      await noteLive('drop');
    }

    // 2. Gateway process killed (all sockets die, /wisp/ unreachable 2 s), then restarted.
    ctx.log('step: 2. Gateway process killed');
    {
      const t0 = Date.now();
      await ctx.killProxy();
      await ctx.sleep(2000);
      const tUp = Date.now();
      await ctx.startProxy();
      const rec = await waitUntil(async () => {
        const rs = (await recoveriesSince(app, tUp - 50));
        const need = SIDES.filter((s) => pair[s.key] === 'epoxy').map((s) => s.engine);
        return need.every((e) => rs.some((r) => r.side === e)) ? rs : null;
      }, 20000);
      const recovered = rec ? Object.fromEntries(rec.map((r) => [r.side, r.t - tUp])) : null;
      const after = await navBoth(app, 'recipe-restart');
      const ups = upgradesSince(ctx, tUp);
      const offline = (await wispSince(app, t0)).filter((w) => w.ev === 'connecting' && w.t < tUp).length;
      for (const s of SIDES) {
        const r = after[s.engine];
        ctx.record({
          engine: s.engine, transport: pair[s.key], test: 'recipe: gateway kill + restart -> recovered',
          result: r.ok && ups.every((u) => u.ticketForm !== 'none') ? 'pass' : 'fail',
          notes: `${navNote(r)}; ${pair[s.key] === 'epoxy' ? `recreated ${recovered?.[s.engine] ?? '?'} ms after restart` : 'lazy reconnect'}; reconnect attempts while down ${offline}; upgrades after restart ${JSON.stringify(summarize(ups))}`,
        });
      }
      await noteLive('restart');
    }

    // 3. Ticket rotation: the gateway stops accepting the old ticket and the app mints a new one.
    ctx.log('step: 3. Ticket rotation');
    {
      const t0 = Date.now();
      const reqBefore = await app.gnome(() => window.gnomeTest.ticketRequests);
      await ctx.command('app', 'setTicket', { ticket: TICKETS.rotated });
      await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.rotated] });
      await ctx.command('proxy', 'dropWisp');
      const rec = await waitUntil(async () => {
        const rs = (await recoveriesSince(app, t0)).filter((r) => r.reason === 'ticket');
        return rs.length >= 2 ? rs : null;
      }, 15000);
      const reqAfter = await app.gnome(() => window.gnomeTest.ticketRequests);
      const after = await navBoth(app, 'recipe-rotated');
      const ups = upgradesSince(ctx, t0);
      const ok101 = ups.filter((u) => u.status === 101);
      const rejected = ups.filter((u) => u.status === 401).length;
      for (const s of SIDES) {
        const r = after[s.engine];
        const allNew = ok101.length > 0 && ok101.every((u) => u.ticketTail === tail(TICKETS.rotated));
        ctx.record({
          engine: s.engine, transport: pair[s.key], test: 'recipe: ticket rotation -> new ticket minted, transports recreated',
          result: r.ok && allNew && rec ? 'pass' : 'fail',
          notes: `${navNote(r)}; ticket requests +${reqAfter - reqBefore}; ticket recreation ${rec ? `${Math.max(...rec.map((x) => x.t)) - t0} ms after rotation` : 'NOT observed'}; old-ticket upgrades refused ${rejected}; upgrades ${JSON.stringify(summarize(ups))}`,
          data: { recoveries: rec },
        });
      }
      await noteLive('rotation');
    }

    // 4. Proactive renewal: a ticket that expires in 5 min + 1.5 s triggers needTicket{expiring} after ~1.5 s.
    ctx.log('step: 4. Proactive renewal');
    {
      await ctx.sleep(2100); // app-side renewal rate limit (2 s)
      const reqBefore = await app.gnome(() => window.gnomeTest.ticketRequests);
      const t0 = Date.now();
      await app.cmd('ticket', { value: TICKETS.rotated, expiresAt: Date.now() + 300e3 + 1500, wispUrl: null }, 20000);
      const tSet = Date.now();
      const renewed = await waitUntil(async () => ((await app.gnome(() => window.gnomeTest.ticketRequests)) > reqBefore ? Date.now() : null), 8000);
      await ctx.sleep(1000);
      const rec = (await recoveriesSince(app, tSet)).filter((r) => r.reason === 'ticket');
      const after = await navBoth(app, 'recipe-renewed');
      for (const s of SIDES) {
        const r = after[s.engine];
        ctx.record({
          engine: s.engine, transport: pair[s.key], test: 'recipe: proactive renewal before expiry',
          result: r.ok && renewed && rec.some((x) => x.side === s.engine) ? 'pass' : 'fail',
          notes: `${navNote(r)}; needTicket{expiring} -> new ticket ${renewed ? renewed - tSet : '?'} ms after set (scheduled 1500); transports recreated ${rec.map((x) => x.side).join(',') || 'none'}; set took ${tSet - t0} ms`,
        });
      }
      await noteLive('renewal');
    }

    // 5. Lazy renewal (settings.lazyRenew): the renewed ticket is stored, only libcurl transports are rebuilt, the
    //    healthy epoxy socket stays; after a later drop every transport reconnects with the NEW ticket.
    ctx.log('step: 5. Lazy renewal');
    {
      await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.first, TICKETS.rotated] });
      await ctx.command('app', 'setTicket', { ticket: TICKETS.first });
      await app.cmd('settings', { lazyRenew: true });
      await ctx.sleep(2100);
      const liveBefore = (await ctx.command('proxy', 'stats')).live;
      const reqBefore = await app.gnome(() => window.gnomeTest.ticketRequests);
      const tSet = Date.now();
      await app.cmd('ticket', { value: TICKETS.rotated, expiresAt: Date.now() + 300e3 + 1500, wispUrl: null }, 20000);
      const renewed = await waitUntil(async () => ((await app.gnome(() => window.gnomeTest.ticketRequests)) > reqBefore ? Date.now() : null), 8000);
      await ctx.sleep(1000);
      const rebuilt = (await recoveriesSince(app, tSet)).filter((r) => r.reason === 'ticket').map((r) => r.side);
      const liveAfter = (await ctx.command('proxy', 'stats')).live;
      const tDrop = Date.now();
      await ctx.command('proxy', 'dropWisp');
      await waitUntil(async () => {
        const rs = await recoveriesSince(app, tDrop);
        return SIDES.filter((x) => pair[x.key] === 'epoxy').every((x) => rs.some((r) => r.side === x.engine)) ? rs : null;
      }, 10000);
      const after = await navBoth(app, 'recipe-lazy');
      const ups = upgradesSince(ctx, tDrop).filter((u) => u.status === 101);
      const newTicket = ups.length > 0 && ups.every((u) => u.ticketTail === tail(TICKETS.first));
      for (const s of SIDES) {
        const kind = pair[s.key];
        const r = after[s.engine];
        const expectRebuilt = kind === 'libcurl';
        const ok = r.ok && renewed && newTicket && rebuilt.includes(s.engine) === expectRebuilt && liveAfter <= liveBefore;
        ctx.record({
          engine: s.engine, transport: kind, test: 'recipe: lazy renewal (no socket leak) then drop -> new ticket',
          result: ok ? 'pass' : 'fail',
          notes: `${navNote(r)}; renewed ${renewed ? renewed - tSet : '?'} ms after set; rebuilt on renewal: ${rebuilt.join(',') || 'none'} (expected ${expectRebuilt ? 'yes' : 'no'}); live sockets ${liveBefore} -> ${liveAfter}; upgrades after drop ${JSON.stringify(summarize(ups))} (new ticket ${newTicket})`,
        });
      }
      await noteLive('lazy');
    }

    // Socket hygiene: recreated transports must not leave their old Wisp sockets open (gateway caps per session).
    await ctx.sleep(1500);
    const live = (await ctx.command('proxy', 'stats')).live;
    // Which side keeps an old socket open: opens minus closes seen by the engine host's WebSocket taps.
    const tap = (await app.stats()).counters.wisp;
    const openBySide = Object.fromEntries(SIDES.map((s) => [`${s.engine}/${pair[s.key]}`, tap.filter((w) => w.side === s.engine && w.ev === 'open').length - tap.filter((w) => w.side === s.engine && w.ev === 'close' && w.wasOpen).length]));
    liveLog.push(`open-by-side:${JSON.stringify(openBySide)}`);
    ctx.record({
      engine: 'both', transport: `${pair.sjt}+${pair.uvt}`, test: 'old sockets closed after recreation',
      result: live <= liveBase ? 'pass' : 'partial',
      notes: `live Wisp sockets at the gateway: ${liveLog.join(' ')} end:${live} (expected 2: one per engine; step 4 rebuilds a healthy epoxy transport)`,
    });
  } catch (e) {
    ctx.record({ engine: 'both', transport: `${pair.sjt}+${pair.uvt}`, test: 'recipe', result: 'fail', notes: String(e.stack || e).slice(0, 400) });
  } finally {
    await tmo(context.close(), 15000, 'context.close').catch((e) => ctx.log(e.message));
    await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.first] }).catch(() => {});
    await ctx.command('app', 'setTicket', { ticket: TICKETS.first }).catch(() => {});
  }
}

// Negative control for the gateway contract: the recipe's 401-vs-426 probe against the SESSION-3 Rust gateway order
// (upgrade check before the ticket check, so a plain GET was always 426): after a ticket rotation the watchdog cannot
// see the rejection and keeps rebuilding epoxy transports with the dead ticket (expectFail). The backend answers the
// probe with 401/426 since session 4; this row shows what breaks if that ever regresses.
async function rustProbeOrder(ctx, browser) {
  const pair = { sjt: 'epoxy', uvt: 'epoxy' };
  const { context, app } = await openPair(ctx, browser, pair, { watchdog: '1' });
  try {
    const first = await navBoth(app, 'rust-order-initial', { create: true });
    await ctx.command('proxy', 'setStrict', { strict: true, probeOrder: 'legacy' });
    const t0 = Date.now();
    const reqBefore = await app.gnome(() => window.gnomeTest.ticketRequests);
    await ctx.command('app', 'setTicket', { ticket: TICKETS.rotated });
    await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.rotated] });
    await ctx.command('proxy', 'dropWisp');
    await ctx.sleep(6000);
    const rebuilds = (await recoveriesSince(app, t0)).length;
    const refused = upgradesSince(ctx, t0).filter((u) => u.status === 401).length;
    const reqAfter = await app.gnome(() => window.gnomeTest.ticketRequests);
    const after = await navBoth(app, 'rust-order-after', { timeout: 12000 });
    for (const s of SIDES) {
      const r = after[s.engine];
      ctx.record({
        engine: s.engine, transport: 'epoxy', test: 'recipe vs the session-3 gateway order (plain GET always 426): rotation detected',
        result: r.ok && reqAfter > reqBefore ? 'pass' : 'fail', expectFail: !r.ok,
        notes: `initial ${first[s.engine].ok ? 'ok' : 'FAILED'}; in 6 s after rotation+drop: ${rebuilds} transport rebuilds, ${refused} upgrades refused with 401, ticket requests +${reqAfter - reqBefore}; then ${navNote(r)}`,
      });
    }
  } catch (e) {
    ctx.record({ engine: 'both', transport: 'epoxy', test: 'recipe vs the session-3 gateway order', result: 'fail', notes: String(e.stack || e).slice(0, 400) });
  } finally {
    await ctx.command('proxy', 'setStrict', { strict: true, probeOrder: 'stub' }).catch(() => {});
    await tmo(context.close(), 15000, 'context.close').catch((e) => ctx.log(e.message));
    await ctx.command('proxy', 'setTickets', { tickets: [TICKETS.first] }).catch(() => {});
    await ctx.command('app', 'setTicket', { ticket: TICKETS.first }).catch(() => {});
  }
}
