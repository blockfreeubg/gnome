// Cookie flood across the origin boundary (docs/WAVE-D.md §6.4, D19): what browsers let a proxied page plant for
// the app's domain, and that gnome-server stays usable under it.
//
// Rows (this build; the rest are recorded as skip with the reason):
//   CF1 sibling hostnames over HTTPS (gnome.localhost + p.gnome.localhost behind a TLS front with Caddy's 4 MiB head
//       limit): from the proxy origin, plant cookies for the parent domain until the browser keeps no more; record
//       how many it keeps and the largest Cookie header the app origin then receives.
//   CF2 with the flood planted, in the dev topology (two ports on 127.0.0.1) and behind the front: the app's
//       /api/config and /api/session work, register (sign-in), a sync round, a Wisp ticket, and a ticket probe on the
//       proxy listener with the flooded cookies.
//   CF3 sibling hostnames: after 200 `Secure; Priority=High` cookies, whether GNOME's session cookie was kept or
//       evicted (recorded per browser); when evicted, a new anonymous session is created at once.
//   CF4 socket level (no browser): 200 KB from 127.0.0.2 (untrusted) → strict 431 on the app listener; from
//       127.0.0.1 → the normal answer; 1.5 MiB from 127.0.0.1 → strict 431; 200 KB on the admin listener → 431; a
//       200 KB Wisp upgrade from 127.0.0.2 → strict 431.
//   CF5–CF8 (memory under the attack shape, the separate-registrable-domain option per browser, renderer-process
//       sharing, 1,000 idle flooded Wisp connections) are measurement rows not run in this build; CF9 (the app's
//       hygiene in a browser) is covered by frontend/src/lib/cookie-hygiene.test.ts here.
// Rows that need WAVE-D M2 detect it (`connections` in /admin/diagnostics); without it they are recorded as skip
// ("expectFail: no M2").
//
//   GNOME_E2E_FLOOD=1 node tests/e2e/engine/suites/cookie-flood.mjs [--browser chromium|firefox|all]
// Gated by GNOME_E2E_FLOOD=1 (one skip row otherwise). Ports: BACKEND_E2E_PORT_BASE (+0..+2 dev server, +10
// HolyWisp, +30 HTTPS front, +40/+42 the front's gnome-server). Needs openssl and certutil like backend-https.mjs.
// The front is the Node front of this file (GNOME_E2E_DEPLOY=1 with d3's Caddy is not wired here yet).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright-core';
import { makeCerts } from './backend-https.mjs';
import {
  PORTS, cleanupAll, installSignalHandlers, parseArgs, prepareSpikeStatic, recorder, sleep, startGnomeServer, startHolyWisp, summarize, workDir,
  writeResults,
} from './backend-lib.mjs';
import { floodedHead, hasM2, pageFetch, plant, startFloodFront, statusOf } from './flood-lib.mjs';

const APP_HOST = 'gnome.localhost';
const PROXY_HOST = 'p.gnome.localhost';
const PW = 'correct horse battery';

export const standalone = true;

export async function run(ctx) {
  ctx.record({ test: 'cookie flood (CF1–CF9)', result: 'skip', notes: 'standalone: GNOME_E2E_FLOOD=1 node tests/e2e/engine/suites/cookie-flood.mjs' });
}

function firefoxProfile(dir, ca) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('certutil', ['-N', '-d', `sql:${dir}`, '--empty-password']);
  if (ca) execFileSync('certutil', ['-A', '-n', 'gnome-e2e-throwaway-ca', '-t', 'C,,', '-i', ca, '-d', `sql:${dir}`]);
  return dir;
}

async function openBrowser(name, certs, profileRoot) {
  if (name === 'chromium') {
    const o = { headless: true, args: [`--ignore-certificate-errors-spki-list=${certs.spki}`] };
    if (process.env.CHROMIUM_EXECUTABLE) o.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else o.channel = 'chromium';
    const browser = await chromium.launch(o);
    return { newContext: () => browser.newContext(), close: () => browser.close() };
  }
  const contexts = [];
  return {
    newContext: async () => {
      const profile = firefoxProfile(path.join(profileRoot, `firefox-${process.pid}-${contexts.length}`), certs.ca);
      const o = { headless: true, firefoxUserPrefs: { 'devtools.jsonview.enabled': false, 'network.dns.localDomains': `${APP_HOST},${PROXY_HOST}` } };
      if (process.env.FIREFOX_EXECUTABLE) o.executablePath = process.env.FIREFOX_EXECUTABLE;
      const c = await firefox.launchPersistentContext(profile, o);
      contexts.push([c, profile]);
      return c;
    },
    close: async () => {
      for (const [c, profile] of contexts) {
        await c.close().catch(() => {});
        rmSync(profile, { recursive: true, force: true });
      }
    },
  };
}

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-gnome-request': '1' }, body: JSON.stringify(body) });

/** CF2's series from an app-origin page: config, session, register, a sync round, a ticket; then a ticket probe. */
async function usable(page, { appOrigin, proxyPort, proxyHost, context, user }) {
  const steps = {};
  steps.config = (await pageFetch(page, `${appOrigin}/api/config`)).status;
  steps.session = (await pageFetch(page, `${appOrigin}/api/session`, json({}))).status;
  steps.register = (await pageFetch(page, `${appOrigin}/api/auth/register`, json({ username: user, password: PW }))).status;
  steps.settings = (await pageFetch(page, `${appOrigin}/api/sync/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-gnome-request': '1' }, body: JSON.stringify({ data: { flood: true } }) })).status;
  steps.bookmarks = (await pageFetch(page, `${appOrigin}/api/sync/bookmarks?limit=10`)).status;
  const t = await pageFetch(page, `${appOrigin}/api/wisp/ticket`, json({}));
  steps.ticket = t.status;
  // The probe runs from Node with the browser's cookies for the proxy host (its documents' policy forbids fetch).
  if (t.status === 200) {
    const cookies = (await context.cookies(`http://${proxyHost}/`)).map((c) => `${c.name}=${c.value}`).join('; ');
    const head = `GET /wisp/?t=${encodeURIComponent(t.body.ticket)} HTTP/1.1\r\nHost: ${proxyHost}:${proxyPort}\r\nCookie: ${cookies}\r\nConnection: close\r\n\r\n`;
    steps.probe = (await statusOf(proxyPort, head, '127.0.0.1')).status;
    steps.probeCookieBytes = cookies.length;
  }
  const ok = steps.config === 200 && steps.session === 200 && steps.register === 201 && steps.settings === 200 && steps.bookmarks === 200 && steps.ticket === 200 && steps.probe === 426;
  return { ok, steps };
}

async function socketRows(record, dev, m2) {
  const r = (test, got, want, note = '') => {
    const ok = got.status === want && (want !== 431 || got.strict);
    record({ test, result: ok ? 'pass' : m2 ? 'fail' : 'skip', notes: `${got.status}${got.strict ? ' strict' : ''}${note}${!ok && !m2 ? ' (expectFail: no M2)' : ''}` });
  };
  const host = `127.0.0.1:${PORTS.app}`;
  r('CF4 200 KB head from untrusted 127.0.0.2 on the app listener: strict 431', await statusOf(PORTS.app, floodedHead({ host, bytes: 200_000 }), '127.0.0.2'), 431);
  r('CF4 200 KB head from trusted 127.0.0.1: the normal answer', await statusOf(PORTS.app, floodedHead({ host, bytes: 200_000 }), '127.0.0.1'), 200);
  r('CF4 1.5 MiB head from 127.0.0.1: strict 431', await statusOf(PORTS.app, floodedHead({ host, bytes: 1_500_000 }), '127.0.0.1'), 431);
  r('CF4 200 KB head on the admin listener: 431', await statusOf(PORTS.admin, floodedHead({ host: `127.0.0.1:${PORTS.admin}`, path: '/admin/diagnostics', bytes: 200_000 }), '127.0.0.1'), 431);
  const upgrade = 'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n';
  r('CF4 200 KB Wisp upgrade head from 127.0.0.2: strict 431', await statusOf(PORTS.app, floodedHead({ host, path: '/wisp/?t=x', bytes: 200_000, extra: upgrade }), '127.0.0.2'), 431);
  void dev;
}

async function browserRows(name, record, { dev, https, front, certs, profileRoot, m2 }) {
  const b = await openBrowser(name, certs, profileRoot);
  const verdict = (ok) => (ok ? 'pass' : m2 ? 'fail' : 'skip');
  try {
    // CF2 dev: two ports on 127.0.0.1 share every cookie.
    {
      const context = await b.newContext();
      const proxyPage = await context.newPage();
      await proxyPage.goto(`${dev.proxyOrigin}/api/health`);
      const planted = await plant(proxyPage, { count: 200, size: 4000 });
      const page = await context.newPage();
      await page.goto(`${dev.appOrigin}/api/health`);
      const res = await usable(page, { appOrigin: dev.appOrigin, proxyPort: PORTS.proxy, proxyHost: '127.0.0.1', context, user: `flood_dev_${name}` });
      record({ test: 'CF2 dev (two ports): with the flood planted the app, session, sign-in, sync, ticket and Wisp probe work', result: verdict(res.ok), notes: `kept ${planted.seen} cookies (${planted.bytes} B of document.cookie); ${JSON.stringify(res.steps)}` });
      await context.close();
    }
    // CF1 + CF2 behind the front + CF3, sibling hostnames over HTTPS.
    {
      const context = await b.newContext();
      const page = await context.newPage();
      await page.goto(`${https.appOrigin}/api/health`);
      const before = await pageFetch(page, `${https.appOrigin}/api/session`, json({}));
      const proxyPage = await context.newPage();
      await proxyPage.goto(`${https.proxyOrigin}/api/health`);
      // CF3: 200 Secure; Priority=High cookies for the parent domain, then: is GNOME's session cookie still there?
      await plant(proxyPage, { count: 200, size: 4000, attrs: `Domain=${APP_HOST}; Path=/; Secure; SameSite=None; Priority=High`, prefix: 'hi' });
      const jar = await context.cookies(`${https.appOrigin}/`);
      const kept = jar.some((c) => c.name === '__Host-gnome_sid');
      let notes = `${name}: __Host-gnome_sid ${kept ? 'kept' : 'evicted'} after 200 Priority=High cookies (${jar.length} cookies for the app host)`;
      let ok = before.status === 200;
      if (!kept) {
        const again = await pageFetch(page, `${https.appOrigin}/api/session`, json({}));
        ok &&= again.status === 200 && (await context.cookies(`${https.appOrigin}/`)).some((c) => c.name === '__Host-gnome_sid');
        notes += `; a new session was created (${again.status})`;
      }
      record({ test: 'CF3 sibling hostnames: session cookie kept or evicted by a Priority=High flood (recorded); evicted means re-created', result: verdict(ok), notes });
      // CF1: plant ordinary cookies until the browser keeps no more.
      const planted = await plant(proxyPage, { count: 250, size: 4000, attrs: `Domain=${APP_HOST}; Path=/; Secure; SameSite=None` });
      await pageFetch(page, `${https.appOrigin}/api/health`);
      const max = front.maxCookieBytes(APP_HOST);
      record({ test: 'CF1 sibling hostnames: cookies a proxied page can plant for the parent domain, and the largest Cookie header the app receives', result: max > 0 ? 'pass' : 'fail', notes: `${name}: ${planted.seen} cookies visible on the proxy host (${planted.bytes} B), largest app-host Cookie header ${max} B (expectation ≈ 740 KB, D19)` });
      const res = await usable(page, { appOrigin: https.appOrigin, proxyPort: https.frontPort, proxyHost: PROXY_HOST, context, user: `flood_https_${name}` });
      // The probe goes to the front's port (it forwards to the one gnome-server listener with X-Forwarded-*); over
      // plain TCP to a TLS port it cannot answer, so the HTTPS series counts without the probe.
      const okHttps = res.steps.config === 200 && res.steps.session === 200 && res.steps.register === 201 && res.steps.settings === 200 && res.steps.bookmarks === 200 && res.steps.ticket === 200;
      delete res.steps.probe;
      delete res.steps.probeCookieBytes;
      record({ test: 'CF2 behind the front: with the flood planted the app, session, sign-in, sync and ticket work', result: verdict(okHttps), notes: JSON.stringify(res.steps) });
      await context.close();
    }
  } finally {
    await b.close();
  }
}

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  const dir = workDir(`cookie-flood-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const all = [];
  if (process.env.GNOME_E2E_FLOOD !== '1') {
    const { rows, record } = recorder('-');
    record({ test: 'cookie flood (CF1–CF9)', result: 'skip', notes: 'set GNOME_E2E_FLOOD=1 to run' });
    writeResults(dir, 'cookie-flood', rows);
    return;
  }
  const certs = makeCerts(path.join(dir, 'certs'));
  const staticDir = args.static ?? (await prepareSpikeStatic(path.join(dir, 'static')));
  const profileRoot = path.join(os.homedir(), '.cache', `gnome-e2e-flood-${process.pid}`);
  try {
    await startHolyWisp(PORTS.holywisp, dir);
    const dev = await startGnomeServer({ dir, staticDir, label: 'dev', env: { GNOME_RATE_LIMIT_SCALE: '0' } });
    const frontPort = PORTS.httpsApp;
    const appOrigin = `https://${APP_HOST}:${frontPort}`;
    const proxyOrigin = `https://${PROXY_HOST}:${frontPort}`;
    const back = PORTS.app + 40;
    await startGnomeServer({
      dir,
      staticDir,
      label: 'front',
      env: {
        GNOME_BIND: `127.0.0.1:${back}`,
        GNOME_PROXY_BIND: '',
        GNOME_ADMIN_BIND: `127.0.0.1:${back + 2}`,
        GNOME_PROXY_ORIGIN: proxyOrigin,
        GNOME_PUBLIC_ORIGINS: appOrigin,
        GNOME_TRUSTED_PROXIES: '127.0.0.1/32',
        GNOME_RATE_LIMIT_SCALE: '0',
      },
    });
    const front = await startFloodFront({ port: frontPort, upstream: `127.0.0.1:${back}`, key: certs.key, cert: certs.cert });
    const m2 = await hasM2(dev.adminOrigin);
    {
      const { rows, record } = recorder('node');
      record({ test: 'M2 present (connections in /admin/diagnostics)', result: m2 ? 'pass' : 'skip', notes: m2 ? '' : 'rows needing M2 are expectFail' });
      await socketRows(record, dev, m2);
      all.push(...rows);
    }
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows, record } = recorder(name);
      try {
        await browserRows(name, record, { dev, https: { appOrigin, proxyOrigin, frontPort }, front, certs, profileRoot, m2 });
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...rows);
    }
    const { rows, record } = recorder('-');
    for (const [row, why] of [
      ['CF5 memory under the attack shape', 'measurement row (RSS sampling, RB11), not run in this build'],
      ['CF6 proxy origin on a separate registrable domain, per browser setting', 'not run in this build'],
      ['CF7 renderer-process sharing with and without Origin-Agent-Cluster', 'not run; Origin-Agent-Cluster is not adopted'],
      ['CF8 1,000 idle Wisp connections with 900 KB upgrade heads', 'measurement row (RB3), not run in this build'],
      ['CF9 hygiene in a browser (sibling site cookie survives, host-only and __Secure- removed)', 'covered by frontend/src/lib/cookie-hygiene.test.ts (fake jar with domain/path rules)'],
    ]) record({ test: row, result: 'skip', notes: why });
    all.push(...rows);
  } finally {
    await cleanupAll();
    rmSync(profileRoot, { recursive: true, force: true });
  }
  writeResults(dir, 'cookie-flood', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  await sleep(10);
  process.exitCode = s.fail ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
