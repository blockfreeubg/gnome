// The real stack for the Wave B e2e suites: HolyWisp (direct upstream + one VPN-profile upstream the suites can
// stop), gnome-server in two-origin mode on loopback serving the e2e build, the spike's local target site (reachable
// only through the VPN profile's HolyWisp, which has the test-only allow-loopback overlay), the leak sentinel, and
// (Wave B step 3, WAVE-B3 §12.1) the content-blocker fixture server plus the run's filter lists (lib/blocker.mjs).
// Everything it starts is stopped by cleanupAll() (also on Ctrl+C).
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cleanupAll, events, onCleanup, portFree, run, sleep, startServer, killServer, waitPort } from '../../spike-engine-host/lib/procs.mjs';
import { startBlockerFixtures } from '../servers/blocker-fixtures.mjs';
import { fetchListing, prepareBlockerLists, removeBigListCopies, requestRefresh, waitForLists } from './blocker.mjs';
import { ADMIN_ORIGIN, APP_ORIGIN, HOLYWISP, HOST, PORTS, PROFILES, PROXY_ORIGIN, REPO_DIR, SERVER_BIN } from './config.mjs';

export { cleanupAll, events, onCleanup, portFree, sleep };

const SPIKE_DIR = path.join(REPO_DIR, 'tests', 'e2e', 'spike-engine-host');

function spawnLogged(name, bin, args, env, logFile) {
  const proc = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let size = 0;
  const keep = (d) => {
    chunks.push(d);
    size += d.length;
    while (size > 4 << 20 && chunks.length > 1) size -= chunks.shift().length;
  };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(t);
    }
    if (logFile) {
      try {
        writeFileSync(logFile, Buffer.concat(chunks));
      } catch {
        /* best effort */
      }
    }
  };
  return { name, proc, exited, stop, log: () => Buffer.concat(chunks).toString() };
}

// ── HolyWisp ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function holywispHealthy(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch(`http://${HOST}:${port}/health`);
      if (r.ok && (await r.json()).status === 'ok') return;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  throw new Error(`HolyWisp on ${port} did not become healthy`);
}

function alpineImage() {
  const m = /^ARG ALPINE_IMAGE=(\S+)/m.exec(readFileSync(HOLYWISP.dockerfile, 'utf8'));
  if (!m) throw new Error(`ARG ALPINE_IMAGE not found in ${HOLYWISP.dockerfile}`);
  return m[1];
}

/**
 * One HolyWisp instance: a copy of services/holywisp/gnome.conf in the run directory (the project copy is never
 * changed), the port given on the command line, optionally the spike's TEST-ONLY allow-loopback overlay.
 * HOLYWISP_RUNNER=host runs the static binary as this user; docker runs it as the spike does: --network host
 * --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 (never privileged).
 */
export async function startHolyWisp({ name, port, runDir, loopback = false }) {
  if (!existsSync(HOLYWISP.bin)) throw new Error(`HolyWisp binary not found at ${HOLYWISP.bin} (services/holywisp/fetch-build.sh)`);
  const conf = path.join(runDir, `holywisp-${name}.conf`);
  copyFileSync(HOLYWISP.conf, conf);
  const overlay = path.join(SPIKE_DIR, 'holywisp-test-only.conf');
  let inst;
  if (HOLYWISP.runner === 'docker') {
    const cname = `gnome-e2e-hw-${name}-${process.pid}`;
    const mounts = ['-v', `${conf}:/etc/holywisp/holywisp.conf:ro`, '-v', `${path.resolve(HOLYWISP.bin)}:/opt/holywisp/holywisp:ro`];
    const confArgs = ['--config', '/etc/holywisp/holywisp.conf'];
    if (loopback) {
      mounts.push('-v', `${overlay}:/etc/holywisp/test-only.conf:ro`);
      confArgs.push('--config', '/etc/holywisp/test-only.conf');
    }
    const lockdown = ['--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534'];
    await run('docker', ['rm', '-f', cname]).catch(() => {});
    await run('docker', ['run', '-d', '--name', cname, ...lockdown, ...mounts, '--entrypoint', '/opt/holywisp/holywisp', alpineImage(), ...confArgs, '--port', String(port)]);
    const stop = async () => {
      try {
        const r = await run('docker', ['logs', cname]);
        writeFileSync(path.join(runDir, `holywisp-${name}.log`), r.stdout + r.stderr);
      } catch {
        /* best effort */
      }
      await run('docker', ['rm', '-f', cname]).catch(() => {});
    };
    inst = { name, port, stop };
  } else {
    const args = ['--config', conf, ...(loopback ? ['--config', overlay] : []), '--port', String(port)];
    const p = spawnLogged(`holywisp-${name}`, HOLYWISP.bin, args, { PATH: process.env.PATH ?? '' }, path.join(runDir, `holywisp-${name}.log`));
    inst = { name, port, stop: p.stop };
  }
  onCleanup(inst.stop);
  await waitPort(port);
  await holywispHealthy(port);
  return inst;
}

// ── gnome-server ─────────────────────────────────────────────────────────────────────────────────────────────────

export function writeProfiles(runDir) {
  const file = path.join(runDir, 'vpn-profiles.toml');
  const profile = (id, label, port) =>
    `[[profile]]\nid = "${id}"\nlabel = "${label}"\ncountry_code = "se"\ncountry = "Sweden"\ncity = "E2E"\nprovider_note = "e2e test upstream"\nwisp_upstream = "${HOST}:${port}"\n`;
  writeFileSync(file, `${profile(PROFILES.live, 'E2E · live', PORTS.vpn)}\n${profile(PROFILES.dead, 'E2E · down', PORTS.dead)}`);
  return file;
}

/** Starts gnome-server serving `staticDir`; `env` adds or overrides variables. Returns {stop, log, env}. */
export async function startGnomeServer({ runDir, staticDir, env = {}, label = 'server', dataDir = path.join(runDir, 'data') }) {
  if (!existsSync(SERVER_BIN)) throw new Error(`gnome-server not found at ${SERVER_BIN} (run with --build-server, or set GNOME_SERVER_BIN)`);
  mkdirSync(dataDir, { recursive: true });
  const base = {
    GNOME_BIND: `${HOST}:${PORTS.app}`,
    GNOME_PROXY_BIND: `${HOST}:${PORTS.proxy}`,
    GNOME_ADMIN_BIND: `${HOST}:${PORTS.admin}`,
    GNOME_STATIC_DIR: staticDir,
    GNOME_DATA_DIR: dataDir,
    GNOME_WISP_UPSTREAM: `${HOST}:${PORTS.holywisp}`,
    GNOME_VPN_PROFILES: writeProfiles(runDir),
    GNOME_ARGON2_MEMORY_KIB: '8192',
    GNOME_FILTERS_REFRESH_HOURS: '0',
    // Wave C (docs/WAVE-C.md §2.2): no catalog import from the internet 30 s after start, no OSS build fetches from
    // GitHub (harmless before Wave C: GNOME_CATALOG_REFRESH_HOURS is a known variable, GNOME_OSS_FETCH is ignored).
    GNOME_CATALOG_REFRESH_HOURS: '0',
    GNOME_OSS_FETCH: 'manual',
    GNOME_LOG: 'info',
  };
  const merged = { ...base, ...env };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GNOME_')));
  const p = spawnLogged('gnome-server', SERVER_BIN, ['serve'], { ...clean, ...merged }, path.join(runDir, `${label}.log`));
  onCleanup(p.stop);
  const ports = [merged.GNOME_BIND, merged.GNOME_PROXY_BIND, merged.GNOME_ADMIN_BIND].filter(Boolean).map((b) => Number(String(b).split(':').pop()));
  const died = p.exited.then(({ code, signal }) => {
    throw new Error(`gnome-server exited early (code ${code}, signal ${signal}):\n${p.log().slice(-3000)}`);
  });
  await Promise.race([Promise.all(ports.map((port) => waitPort(port))), died]);
  return { ...p, env: merged };
}

// ── The whole stack ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Starts everything and returns ctx.stack (README.md: the suite API). `serverEnv` applies to every start of
 * gnome-server; restartServer(env) restarts it with these extra variables (e.g. GNOME_ACCESS_MODE=code) and an
 * empty object restores the defaults. The data directory survives restarts (sessions stay valid).
 * `blocker`: {mode: 'test' (default) | 'real' (--blocker-real), offline} for the run's filter lists (lib/blocker.mjs);
 * the fixture server always runs.
 */
export async function startStack({ runDir, staticDir, serverEnv = {}, withTarget = true, blocker = {} }) {
  const upstreams = new Map();
  upstreams.set('direct', { port: PORTS.holywisp, loopback: false, inst: await startHolyWisp({ name: 'direct', port: PORTS.holywisp, runDir }) });
  upstreams.set(PROFILES.live, { port: PORTS.vpn, loopback: true, inst: await startHolyWisp({ name: PROFILES.live, port: PORTS.vpn, runDir, loopback: true }) });

  // The spike's local target site and leak sentinel (forked with this runner's ports).
  const spikeEnv = {
    SPIKE_TARGET_PORT: String(PORTS.target),
    SPIKE_SENTINEL_PORT: String(PORTS.sentinel),
    SPIKE_APP_PORT: String(PORTS.app),
    SPIKE_PROXY_PORT: String(PORTS.proxy),
    SPIKE_RUN_DIR: runDir,
  };
  await startServer('sentinel', 'sentinel.mjs', spikeEnv);
  onCleanup(() => killServer('sentinel', 'SIGTERM'));
  if (withTarget) {
    await startServer('target', 'target.mjs', spikeEnv);
    onCleanup(() => killServer('target', 'SIGTERM'));
  }

  // Content-blocker fixtures and lists (WAVE-B3 §12.1): GNOME_FILTER_LISTS_FILE goes into every server start.
  const lists = prepareBlockerLists({ runDir, mode: blocker.mode ?? 'test', offline: blocker.offline ?? false });
  // The generated big list's copies (the run's and the server's stored versions, ~28 MB) go when the run ends:
  // registered before the servers start, so it runs after they stopped (cleanups run in reverse order).
  if (lists.dir) onCleanup(() => void removeBigListCopies({ listsDir: lists.dir, dataDir: path.join(runDir, 'data') }));
  const fixtures = await startBlockerFixtures({ port: PORTS.blocker, log: (m) => console.log(`     ${m}`) });
  onCleanup(() => fixtures.close());
  if (lists.toml) serverEnv = { GNOME_FILTER_LISTS_FILE: lists.toml, ...serverEnv };

  let server = await startGnomeServer({ runDir, staticDir, env: serverEnv });
  let restarts = 0;
  const waitLists = (opts = {}) =>
    waitForLists({ appOrigin: APP_ORIGIN, adminOrigin: ADMIN_ORIGIN, expect: lists.expect, timeoutMs: lists.mode === 'real' ? 300_000 : 120_000, ...opts });
  // File lists are read as soon as the server serves (its `filters.files` job); the resources (and in real mode every
  // list) come from upstream only when asked: GNOME_FILTERS_REFRESH_HOURS is 0 here.
  const listsReady = await waitLists({ refresh: lists.resources === 'upstream' });
  if (lists.mode === 'test' && listsReady.unexpected.length) {
    throw new Error(`gnome-server lists filter lists the e2e TOML did not disable: ${listsReady.unexpected.join(', ')} (add them to BUILTIN_LIST_IDS in lib/blocker.mjs)`);
  }
  console.log(
    listsReady.ok
      ? `filter lists ready in ${listsReady.ms} ms (${lists.mode}${lists.offline ? ', offline' : ''}: ${lists.expect.join(', ')})`
      : `WARNING: filter lists not ready after ${listsReady.ms} ms: missing ${listsReady.missing.join(', ') || '-'}, unavailable ${listsReady.unavailable.join(', ') || '-'}${lists.resources === 'upstream' ? ' (no internet? run with --offline for the pinned resources)' : ''}`,
  );
  const stack = {
    appOrigin: APP_ORIGIN,
    proxyOrigin: PROXY_ORIGIN,
    appOrigins: [APP_ORIGIN],
    adminOrigin: ADMIN_ORIGIN,
    admin: ADMIN_ORIGIN,
    staticDir,
    profiles: { ...PROFILES },
    /** A VPN profile whose upstream never runs (its probe answers 426 or 503, its upgrade fails). */
    deadProfile: PROFILES.dead,
    /** The local target site, reachable only through `/wisp/p/<profiles.live>/` (the allow-loopback HolyWisp). */
    target: withTarget ? { origin: `http://${HOST}:${PORTS.target}`, altOrigin: `http://localhost:${PORTS.target}` } : null,
    sentinel: { origin: `http://${HOST}:${PORTS.sentinel}`, since: (t) => events.filter((e) => e.from === 'sentinel' && e.type === 'sentinel' && e.at >= t) },
    serverLog: () => server.log(),
    /**
     * The content blocker's fixtures and lists (WAVE-B3 §12.1). `fixtures`: servers/blocker-fixtures.mjs's API
     * (requests, beacons, ws, mark, reset); `origin(label)` / `url(label, path)` for `<label>.localhost` (reach them
     * with `route: 'profile:e2e-vpn'`); `lists`: this run's file lists ({id, name, category, trusted, default, maxMb,
     * file} each; `big` is the generated big list); `ready`: how the lists stood after the start
     * ({ok, ms, listing, missing, unavailable}).
     */
    blocker: {
      mode: lists.mode,
      offline: lists.offline,
      port: PORTS.blocker,
      fixtures,
      labels: fixtures.labels,
      hosts: fixtures.hosts,
      origin: fixtures.origin,
      url: fixtures.url,
      toml: lists.toml,
      listsDir: lists.dir,
      lists: lists.lists,
      expect: lists.expect,
      ready: listsReady,
      /** GET /api/filters of the running server. */
      listing: () => fetchListing(APP_ORIGIN),
      /** Waits for every list of this run to be available ({refresh: true} asks for an upstream check first). */
      waitForLists: waitLists,
      /** Rewrites this run's copy of a file list (test mode); the server reads it at its next refresh. */
      writeList(id, text) {
        const l = lists.lists.find((x) => x.id === id);
        if (!l) throw new Error(`no file list ${id} in this run (${lists.lists.map((x) => x.id).join(', ')})`);
        writeFileSync(l.file, text);
        return l.file;
      },
      /**
       * Makes the server re-read lists now. via 'cli' (default): `gnome-server filters refresh [ids…]` as a second
       * process on the same data directory, as an operator would (resolves {code, stdout, stderr}); via 'admin':
       * `POST /admin/filters/refresh` (every list, in the background; resolves when accepted).
       */
      async refreshLists({ ids = [], via = 'cli' } = {}) {
        if (via === 'admin') return requestRefresh(ADMIN_ORIGIN);
        const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GNOME_')));
        try {
          const r = await run(SERVER_BIN, ['filters', 'refresh', ...ids], { env: { ...clean, ...server.env, GNOME_LOG: 'warn' }, timeout: 120_000 });
          return { code: 0, ...r };
        } catch (e) {
          return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) };
        }
      },
    },
    async restartServer(env = {}) {
      await server.stop();
      restarts += 1;
      server = await startGnomeServer({ runDir, staticDir, env: { ...serverEnv, ...env }, label: `server-r${restarts}` });
    },
    upstream(name) {
      const u = upstreams.get(name === 'direct' ? 'direct' : name);
      if (!u) throw new Error(`unknown upstream ${name} (known: ${[...upstreams.keys()].join(', ')})`);
      return {
        async stop() {
          if (!u.inst) return;
          await u.inst.stop();
          u.inst = null;
          for (let i = 0; i < 50 && !(await portFree(u.port)); i++) await sleep(100);
        },
        async start() {
          if (u.inst) return;
          u.inst = await startHolyWisp({ name: `${name}-restart-${Date.now()}`, port: u.port, runDir, loopback: u.loopback });
        },
      };
    },
  };
  return stack;
}

export async function portsInUse() {
  const busy = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port))) busy.push(`${name}:${port}`);
  return busy;
}
