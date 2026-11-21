#!/usr/bin/env node
/**
 * The engine-host spike (tests/e2e/spike-engine-host, docs/research/spike-engine-host.md) served by a real gnome-server
 * instead of the spike's Node stubs: real two-origin roles and headers, real Wisp tickets from POST /api/wisp/ticket,
 * the real /wisp/ gateway (Origin, ticket parsing, probe) and a real HolyWisp behind it. Until Wave B ships the real
 * engine host, this is how backend changes are checked against both engines and all four transports.
 *
 *   node tests/e2e/stack/engine-on-gnome-server.mjs prepare <dir> <app origin>   # e.g. … /tmp/x http://127.0.0.1:24210
 *   GNOME_STATIC_DIR=<dir> GNOME_BIND=127.0.0.1:24210 GNOME_PROXY_BIND=127.0.0.1:24211 \
 *     GNOME_WISP_UPSTREAM=<holywisp host:port> GNOME_DATA_DIR=<temp dir> target/release/gnome-server serve
 *   GNOME_QA_APP=http://127.0.0.1:24210 node tests/e2e/stack/engine-on-gnome-server.mjs
 *
 * `prepare` assembles a GNOME_STATIC_DIR from the spike: the app stub as the SPA (index.html, app.js), the engine host
 * under engine/ (its %GNOME_APP_ORIGINS% placeholder filled in), sw.js, and the pinned engine/transport builds under
 * vendor/ (copied unmodified from tests/e2e/node_modules; run `npm ci` in tests/e2e first). The app origin given must
 * be the one the browser opens (the loopback GNOME_BIND address in dev).
 *
 * The run checks, in Chromium and Firefox: every engine x transport (Scramjet over libcurl 2.0.6 / epoxy 3.0.2, UV over
 * epoxy 2.1.29 / libcurl 1.5.2) loads https://example.com/ with each ticket URL form (?t=<ticket>&/, ?t=<ticket>/,
 * ?t=<ticket>; libcurl refuses the last one, which is reported as an expected failure); the engine host's ticket probe
 * (a same-origin GET from the engine-host frame, which sends no Origin) gets 426 for a valid ticket in every form and
 * 401 wisp_ticket_invalid / wisp_ticket_missing otherwise; a WebSocket opened by the engine-host page (browser Origin)
 * upgrades with a valid ticket and fails with a forged one. To try an engine-host Content-Security-Policy, start
 * gnome-server with GNOME_PROXY_CSP and run again (the header sent on /engine/ is printed).
 * Env: GNOME_QA_APP (required), GNOME_QA_BROWSERS (default chromium,firefox), GNOME_QA_FORMS (default
 * query+amp-slash,query+slash,query), GNOME_QA_SITE (default https://example.com/, expected title "Example Domain").
 * Browsers run without the spike's leak sentinel (this is a functional check, not a leak check). Exits 1 on any
 * unexpected failure.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { NODE_MODULES, SPIKE_DIR, VENDOR } from '../spike-engine-host/lib/config.mjs';

if (process.argv[2] === 'prepare') {
  const [, , , dir, appOrigin] = process.argv;
  if (!dir || !/^https?:\/\/[^/]+$/.test(appOrigin ?? '')) {
    console.error('usage: engine-on-gnome-server.mjs prepare <dir> <app origin, e.g. http://127.0.0.1:24210>');
    process.exit(2);
  }
  const web = path.join(SPIKE_DIR, 'web');
  mkdirSync(path.join(dir, 'engine'), { recursive: true });
  for (const f of ['index.html', 'app.js']) cpSync(path.join(web, 'app', f), path.join(dir, f));
  for (const f of readdirSync(path.join(web, 'proxy', 'engine'))) cpSync(path.join(web, 'proxy', 'engine', f), path.join(dir, 'engine', f));
  const host = path.join(dir, 'engine', 'index.html');
  writeFileSync(host, readFileSync(host, 'utf8').replace('%GNOME_APP_ORIGINS%', appOrigin));
  cpSync(path.join(web, 'proxy', 'sw.js'), path.join(dir, 'sw.js'));
  for (const [name, rel] of Object.entries(VENDOR)) {
    cpSync(path.join(NODE_MODULES, rel), path.join(dir, 'vendor', name), { recursive: true, dereference: true });
  }
  console.log(`prepared ${dir} for app origin ${appOrigin} (vendor: ${Object.keys(VENDOR).join(', ')})`);
  process.exit(0);
}

const { launch, newContext } = await import('../spike-engine-host/lib/browsers.mjs');
const { openApp } = await import('../spike-engine-host/lib/drive.mjs');

const APP = (process.env.GNOME_QA_APP ?? '').replace(/\/$/, '');
if (!APP) {
  console.error('Set GNOME_QA_APP to the app origin of a gnome-server serving a `prepare`d static dir.');
  process.exit(2);
}
const BROWSERS = (process.env.GNOME_QA_BROWSERS ?? 'chromium,firefox').split(',');
const FORMS = (process.env.GNOME_QA_FORMS ?? 'query+amp-slash,query+slash,query').split(',');
const SITE = process.env.GNOME_QA_SITE ?? 'https://example.com/';
const COMBOS = [
  { engine: 'scramjet', sjt: 'libcurl' },
  { engine: 'scramjet', sjt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'libcurl' },
];

const config = await (await fetch(`${APP}/api/config`)).json();
const PROXY = config.proxy.origin;
const engineCsp = (await fetch(`${PROXY}/engine/`)).headers.get('content-security-policy');
console.log(`app ${APP}, proxy ${PROXY} (isolated ${config.proxy.isolated}), ticket TTL ${config.wisp.ticket_ttl_s} s`);
console.log(`engine-host CSP: ${engineCsp}`);

const rows = [];
const record = (row) => {
  rows.push(row);
  console.log(`  ${row.result.padEnd(5)} [${row.browser}] ${row.test}${row.notes ? ` (${row.notes})` : ''}`);
};

for (const name of BROWSERS) {
  const browser = await launch(name, { sentinelProxy: false });
  try {
    for (const combo of COMBOS) {
      const kind = combo.sjt ?? combo.uvt;
      for (const form of FORMS) {
        const context = await newContext(browser);
        const label = `${combo.engine}/${kind} ticketForm=${form}`;
        try {
          const app = await openApp(context, { ...combo, ticketForm: form, fallback: 0 }, { origin: APP, timeout: 60_000 });
          const r = await app.navigate(1, SITE, { create: true, engine: combo.engine, timeout: 45_000 });
          // libcurl-transport (1.x and 2.x) refuses a Wisp URL that does not end in "/".
          const expected = form === 'query' && kind === 'libcurl';
          const ok = r.ok && (SITE !== 'https://example.com/' || r.title === 'Example Domain');
          record({ browser: name, test: `${label}: ${SITE}`, result: ok ? 'pass' : expected ? 'xfail' : 'fail', notes: ok ? `${r.ms} ms, "${r.title}"` : JSON.stringify(r.error) });
          if (combo === COMBOS[0] && form === FORMS[0]) {
            const host = app.page.frames().find((f) => f.url().startsWith(`${PROXY}/engine/`));
            const ticket = await app.page.evaluate(async () => (await (await fetch('/api/wisp/ticket', { method: 'POST', headers: { 'X-GNOME-Request': '1' } })).json()).ticket);
            const probes = await host.evaluate(async (t) => {
              const st = async (q) => {
                const res = await fetch(`/wisp/${q}`, { cache: 'no-store' });
                let code = null;
                try { code = (await res.json()).error.code; } catch { /* not JSON */ }
                return `${res.status} ${code}`;
              };
              const forged = t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
              return { amp: await st(`?t=${t}&/`), slash: await st(`?t=${t}/`), plain: await st(`?t=${encodeURIComponent(t)}`), forged: await st(`?t=${forged}&/`), missing: await st('') };
            }, ticket);
            const probeOk = [probes.amp, probes.slash, probes.plain].every((p) => p === '426 upgrade_required') && probes.forged === '401 wisp_ticket_invalid' && probes.missing === '401 wisp_ticket_missing';
            record({ browser: name, test: 'engine-host probe (same-origin GET) against the real gateway', result: probeOk ? 'pass' : 'fail', notes: JSON.stringify(probes) });
            const ws = await host.evaluate(async (t) => {
              const attempt = (u) => new Promise((res) => {
                const s = new WebSocket(u);
                s.onopen = () => { s.close(); res('open'); };
                s.onerror = () => res('error');
                setTimeout(() => res('timeout'), 8000);
              });
              const base = location.origin.replace(/^http/, 'ws');
              return { valid: await attempt(`${base}/wisp/?t=${t}&/`), forged: await attempt(`${base}/wisp/?t=${t.slice(0, -2)}xx&/`) };
            }, ticket);
            record({ browser: name, test: 'engine-host WebSocket (browser Origin): valid ticket opens, forged fails', result: ws.valid === 'open' && ws.forged === 'error' ? 'pass' : 'fail', notes: JSON.stringify(ws) });
          }
        } catch (e) {
          record({ browser: name, test: label, result: 'fail', notes: String(e.message || e).slice(0, 300) });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}
const count = (r) => rows.filter((x) => x.result === r).length;
console.log(`\n${count('pass')} pass, ${count('xfail')} expected failures, ${count('fail')} unexpected failures`);
process.exit(count('fail') ? 1 : 0);
