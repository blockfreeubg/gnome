// Lane e (backend) e2e suite: GNOME over HTTPS with two hostnames, like a production deployment (docs/WAVE-B.md §6
// "Tests", §10 "HTTPS with two hostnames"; ARCHITECTURE §4.6 "Deployment").
//
// The topology: a TLS-terminating reverse proxy (a small Node HTTPS server in this file, standing in for Caddy) on one
// loopback port serves two hostnames, gnome.localhost (the app) and p.gnome.localhost (the proxy origin), and forwards
// both to ONE gnome-server listener with X-Forwarded-Proto/-Host/-For (trusted from 127.0.0.1), so the role comes
// from the Host as in production. HolyWisp sits behind the gateway. The certificate comes from a throwaway local CA
// that only the test browsers trust: Chromium through --ignore-certificate-errors-spki-list (the leaf's key), Firefox
// through the CA in its own profile's NSS database (certutil); *.localhost resolves to loopback inside Chromium, and
// Firefox gets network.dns.localDomains for the two names. Nothing changes the host's resolver or trust store.
//
// Checks per browser: /api/config names https://p.gnome.localhost:<port> and isolation; the engine-host and
// bare-mux worker policies on the proxy hostname equal engineHostCsp(['https://gnome.localhost:<port>']) /
// bareMuxWorkerCsp() + bareMuxWorkerScriptCsp(), /api/health's proxyInertCsp(); the app's session cookie is __Host-gnome_sid with Secure and is never sent to the proxy
// hostname; every engine x transport loads https://example.com/ through wss://p.gnome.localhost:<port>/wisp/ with
// the spike's app stub and engine host (secure context, service worker, Origin and ticket checks over TLS), or, with
// `--static <dist>` of a Wave B e2e build (`tests/e2e/engine/run.mjs` builds one with its driver page), with the real
// engine host driven by the runner's e2e driver (`<app origin>/e2e-driver/`, tests/e2e/engine/lib/drive.mjs).
//
//   node tests/e2e/engine/suites/backend-https.mjs [--browser chromium|firefox|all] [--static <e2e dist>]
// Needs openssl and certutil (nss tools). Ports: BACKEND_E2E_PORT_BASE (+30 for the HTTPS front, +0 for gnome-server,
// +10 HolyWisp). The Firefox profile lives under BACKEND_E2E_PROFILE_DIR (default ~/.cache/gnome-e2e-backend) and is
// deleted afterwards. Under tests/e2e/engine/run.mjs it runs as a standalone suite (`standalone` below): once per run,
// as a child process with the runner's build (`--static`) on the runner's standalone port block.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright-core';
import {
  PORTS, assertPortsFree, cleanupAll, installSignalHandlers, loadContract, onCleanup, parseArgs, prepareSpikeStatic, recorder,
  sleep, startGnomeServer, startHolyWisp, summarize, workDir, writeResults,
} from './backend-lib.mjs';

const APP_HOST = 'gnome.localhost';
const PROXY_HOST = 'p.gnome.localhost';

/** A local CA and a leaf for both hostnames (EC P-256, valid 2 days). Returns paths and the leaf's SPKI hash. */
export function makeCerts(dir) {
  mkdirSync(dir, { recursive: true });
  const o = (args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2',
    '-subj', '/CN=GNOME e2e throwaway CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  o(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${APP_HOST}`]);
  writeFileSync(path.join(dir, 'leaf.ext'), `subjectAltName=DNS:${APP_HOST},DNS:${PROXY_HOST}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
  o(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext']);
  const pub = o(['x509', '-in', 'leaf.pem', '-pubkey', '-noout']);
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pub });
  const spki = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
  return { ca: path.join(dir, 'ca.pem'), key: path.join(dir, 'leaf.key'), cert: path.join(dir, 'leaf.pem'), spki };
}

/**
 * The TLS-terminating reverse proxy: every request and WebSocket upgrade for either hostname goes to `upstream`
 * (host:port) with X-Forwarded-Proto: https, X-Forwarded-Host and X-Forwarded-For. Records which hosts were sent a
 * Cookie header (`cookieHosts`).
 */
export async function startTlsFront({ port, upstream, key, cert }) {
  const [uHost, uPort] = upstream.split(':');
  const seen = [];
  const forwardedHeaders = (req) => {
    const h = { ...req.headers };
    for (const k of Object.keys(h)) if (k.startsWith('x-forwarded-')) delete h[k];
    h['x-forwarded-proto'] = 'https';
    h['x-forwarded-host'] = req.headers.host ?? '';
    h['x-forwarded-for'] = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '127.0.0.1';
    seen.push({ host: req.headers.host, path: req.url.split('?')[0], cookie: req.headers.cookie ?? null });
    if (seen.length > 5000) seen.splice(0, 1000);
    return h;
  };
  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const up = http.request({ host: uHost, port: Number(uPort), method: req.method, path: req.url, headers: forwardedHeaders(req) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.rawHeaders);
      r.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('bad gateway');
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(Number(uPort), uHost, () => {
      const h = forwardedHeaders(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`])), '', ''];
      up.write(lines.join('\r\n'));
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  onCleanup(close);
  return { close, seen };
}

/** Firefox profile whose NSS database trusts only the throwaway CA (plus Firefox's built-ins). */
function firefoxProfile(dir, ca) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync('certutil', ['-N', '-d', `sql:${dir}`, '--empty-password']);
  execFileSync('certutil', ['-A', '-n', 'gnome-e2e-throwaway-ca', '-t', 'C,,', '-i', ca, '-d', `sql:${dir}`]);
  return dir;
}

const COMBOS = [
  { engine: 'scramjet', sjt: 'libcurl' },
  { engine: 'scramjet', sjt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'epoxy' },
  { engine: 'ultraviolet', uvt: 'libcurl' },
];

async function checks(name, context, record, { appOrigin, proxyOrigin, front, real = false }) {
  const m = await loadContract();
  // The real engine host through the runner's e2e driver page, or the spike's app stub and engine host.
  const open = real
    ? async (combo, transport) => (await import('../lib/drive.mjs')).openApp(context, { engine: combo.engine, transport, fallback: 0 }, { origin: appOrigin, timeout: 60_000 })
    : async (combo) => (await import('../../spike-engine-host/lib/drive.mjs')).openApp(context, { ...combo, ticketForm: 'query+amp-slash', fallback: 0 }, { origin: appOrigin, timeout: 60_000 });
  const hostKind = real ? 'the Wave B engine host' : 'the spike engine host';
  const page = await context.newPage();
  await page.goto(`${appOrigin}/api/health`);
  const config = await page.evaluate(async () => (await fetch('/api/config')).json());
  record({ test: 'https: /api/config names the proxy hostname, isolated', result: config.proxy?.origin === proxyOrigin && config.proxy?.isolated === true ? 'pass' : 'fail', notes: JSON.stringify(config.proxy) });
  const secure = await page.evaluate(() => window.isSecureContext);
  record({ test: 'https: the app page is a secure context (certificate trusted by this profile only)', result: secure ? 'pass' : 'fail' });

  // Headers on the proxy hostname, read from a proxy-origin page (same-origin fetch reads every header).
  const host = await context.newPage();
  await host.goto(`${proxyOrigin}/engine/`);
  const hdr = await host.evaluate(async () => {
    const get = async (p) => (await fetch(p, { cache: 'no-store' })).headers.get('content-security-policy');
    return { engine: await get('/engine/'), worker: await get('/vendor/bare-mux/worker.js'), health: await get('/api/health') };
  });
  const wantEngine = m.engineHostCsp([appOrigin]);
  record({ test: 'https: /engine/ CSP equals engineHostCsp([app origin])', result: hdr.engine === wantEngine ? 'pass' : 'fail', notes: hdr.engine });
  // bareMuxWorkerCsp(), then bareMuxWorkerScriptCsp() as a second policy (fetch joins the two header values with ", ").
  const wantWorker = `${m.bareMuxWorkerCsp()}, ${m.bareMuxWorkerScriptCsp([appOrigin])}`;
  record({ test: 'https: /vendor/bare-mux/worker.js CSP is bareMuxWorkerCsp() plus the script policy', result: hdr.worker === wantWorker ? 'pass' : 'fail', notes: hdr.worker });
  record({ test: 'https: /api/health on the proxy hostname is proxyInertCsp([app origin])', result: hdr.health === m.proxyInertCsp([appOrigin]) ? 'pass' : 'fail', notes: hdr.health });

  // The session cookie: __Host- and Secure, host-only, never sent to the proxy hostname.
  const status = await page.evaluate(async () => (await fetch('/api/session', { method: 'POST', headers: { 'X-GNOME-Request': '1' } })).status);
  const jar = await context.cookies([appOrigin, proxyOrigin]);
  const sid = jar.find((c) => c.name === '__Host-gnome_sid');
  record({ test: 'https: __Host-gnome_sid is Secure, HttpOnly, SameSite=Strict, host-only', result: status === 200 && sid?.secure && sid.httpOnly && sid.sameSite === 'Strict' && sid.domain === APP_HOST ? 'pass' : 'fail', notes: JSON.stringify(jar.map((c) => ({ n: c.name, d: c.domain, s: c.secure }))) });
  await host.evaluate(async () => fetch('/api/health', { cache: 'no-store', credentials: 'include' }));
  await page.close();
  await host.close();

  // Both engines, all four transports, over wss://p.gnome.localhost/wisp/.
  for (const combo of COMBOS) {
    const transport = combo.sjt ?? combo.uvt;
    const test = `https: https://example.com/ through the proxy hostname (${hostKind})`;
    try {
      const app = await open(combo, transport);
      const r = await app.navigate(1, 'https://example.com/', { create: true, engine: combo.engine, timeout: 45_000 });
      record({ test, engine: combo.engine, transport, result: r.ok && r.title === 'Example Domain' ? 'pass' : 'fail', notes: r.ok ? `${r.ms} ms` : JSON.stringify(r.error).slice(0, 300) });
      await app.page.close();
    } catch (e) {
      record({ test, engine: combo.engine, transport, result: 'fail', notes: String(e.message || e).slice(0, 300) });
    }
  }
  const leakedCookie = front.seen.filter((s) => s.host?.startsWith(`${PROXY_HOST}:`) && /gnome_(sid|auth)=/.test(s.cookie ?? ''));
  record({ test: 'https: no request to the proxy hostname carried the app session cookie', result: leakedCookie.length === 0 ? 'pass' : 'fail', notes: `${front.seen.filter((s) => s.host?.startsWith(`${PROXY_HOST}:`)).length} proxy-host requests, ${leakedCookie.length} with a session cookie` });
}

/** The runner (run.mjs) starts this file as a child process with its own server layout instead of calling run(ctx). */
export const standalone = true;

export async function run(ctx) {
  // Under the shared runner this suite brings its own TLS front and server configuration (two hostnames on one
  // listener), so it needs restartServer(env) with these settings.
  const { record, stack } = ctx;
  if (!stack.https) {
    record({ test: 'https two-hostname run', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/backend-https.mjs' });
    return;
  }
  const { context, close } = await stack.https.open(ctx.browser);
  try {
    await checks(ctx.browser, context, record, stack.https);
  } finally {
    await close();
  }
}

async function main() {
  const args = parseArgs();
  installSignalHandlers();
  const dir = workDir(`https-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const certs = makeCerts(path.join(dir, 'certs'));
  const staticDir = args.static ?? (await prepareSpikeStatic(path.join(dir, 'static')));
  const real = Boolean(args.static);
  if (real && !existsSync(path.join(staticDir, 'e2e-driver', 'index.html'))) {
    throw new Error(`${staticDir} has no e2e-driver/ (use a dist that tests/e2e/engine/run.mjs built)`);
  }
  const port = PORTS.httpsApp;
  const appOrigin = `https://${APP_HOST}:${port}`;
  const proxyOrigin = `https://${PROXY_HOST}:${port}`;
  await startHolyWisp(PORTS.holywisp, dir);
  await startGnomeServer({
    dir,
    staticDir,
    label: 'server-https',
    env: { GNOME_PROXY_BIND: '', GNOME_PROXY_ORIGIN: proxyOrigin, GNOME_PUBLIC_ORIGINS: appOrigin, GNOME_TRUSTED_PROXIES: '127.0.0.1/32' },
  });
  const front = await startTlsFront({ port, upstream: `127.0.0.1:${PORTS.app}`, key: certs.key, cert: certs.cert });
  const profileRoot = process.env.BACKEND_E2E_PROFILE_DIR || path.join(os.homedir(), '.cache', 'gnome-e2e-backend');
  const stack = {
    https: {
      appOrigin,
      proxyOrigin,
      front,
      real,
      open: async (name) => {
        if (name === 'chromium') {
          const o = { headless: true, args: [`--ignore-certificate-errors-spki-list=${certs.spki}`] };
          if (process.env.CHROMIUM_EXECUTABLE) o.executablePath = process.env.CHROMIUM_EXECUTABLE;
          else o.channel = 'chromium';
          const browser = await chromium.launch(o);
          const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
          return { context, close: () => browser.close() };
        }
        const profile = firefoxProfile(path.join(profileRoot, `firefox-${process.pid}`), certs.ca);
        const o = {
          headless: true,
          viewport: { width: 1280, height: 860 },
          firefoxUserPrefs: { 'devtools.jsonview.enabled': false, 'network.dns.localDomains': `${APP_HOST},${PROXY_HOST}` },
        };
        if (process.env.FIREFOX_EXECUTABLE) o.executablePath = process.env.FIREFOX_EXECUTABLE;
        const context = await firefox.launchPersistentContext(profile, o);
        return {
          context,
          close: async () => {
            await context.close();
            rmSync(profile, { recursive: true, force: true });
          },
        };
      },
    },
  };
  const all = [];
  try {
    for (const name of args.browsers) {
      console.log(`\n${name}`);
      const { rows, record } = recorder(name);
      try {
        await run({ browser: name, suite: 'backend-https', runDir: dir, record, sleep, log: console.log, stack });
      } catch (e) {
        record({ test: 'suite', result: 'fail', notes: String(e.stack || e).slice(0, 600) });
      }
      all.push(...rows);
    }
  } finally {
    await cleanupAll();
    rmSync(profileRoot, { recursive: true, force: true });
  }
  writeResults(dir, 'backend-https', all);
  const s = summarize(all);
  console.log(`\n${s.pass} pass, ${s.fail} fail, ${s.skip} skip — results in ${dir}`);
  await assertPortsFree();
  process.exitCode = s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
