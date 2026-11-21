// HolyWisp for the harness: the binary built by services/holywisp/fetch-build.sh, run in a locked-down
// container that shares the host's network namespace (exactly like services/holywisp/tests/smoke.sh), so it
// listens on the host's 127.0.0.1 like a gateway-side deployment.
//   prod instance: services/holywisp/gnome.conf, only --port changed
//   test instance: gnome.conf + holywisp-test-only.conf (allow-loopback), reached only via /wisp/p/test-loopback/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOLYWISP, PORTS, RESULTS_DIR } from './config.mjs';
import { run, waitPort, onCleanup, sleep } from './procs.mjs';

const instances = [];

function alpineImage() {
  const df = fs.readFileSync(HOLYWISP.dockerfile, 'utf8');
  const m = /^ARG ALPINE_IMAGE=(\S+)/m.exec(df);
  if (!m) throw new Error(`ARG ALPINE_IMAGE not found in ${HOLYWISP.dockerfile}`);
  return m[1];
}

async function health(port) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok && (await r.json()).status === 'ok') return;
    } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error(`HolyWisp on ${port} did not become healthy`);
}

export async function startHolyWisp(kind) {
  const port = kind === 'prod' ? PORTS.hwProd : PORTS.hwTest;
  const confArgs = ['--config', '/etc/holywisp/holywisp.conf'];
  const mounts = ['-v', `${HOLYWISP.conf}:/etc/holywisp/holywisp.conf:ro`];
  if (kind === 'test') {
    confArgs.push('--config', '/etc/holywisp/test-only.conf');
    mounts.push('-v', `${HOLYWISP.testOnlyConf}:/etc/holywisp/test-only.conf:ro`);
  }
  const args = [...confArgs, '--port', String(port)];
  if (HOLYWISP.runner === 'host') {
    if (!fs.existsSync(HOLYWISP.bin)) throw new Error(`HOLYWISP_BIN not found: ${HOLYWISP.bin}`);
    const hostArgs = ['--config', HOLYWISP.conf, ...(kind === 'test' ? ['--config', HOLYWISP.testOnlyConf] : []), '--port', String(port)];
    const proc = spawn(HOLYWISP.bin, hostArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    const log = [];
    proc.stderr.on('data', (d) => log.push(d.toString()));
    const inst = { kind, port, stop: async () => { proc.kill('SIGTERM'); }, logs: async () => log.join('') };
    instances.push(inst);
    onCleanup(inst.stop);
    await waitPort(port);
    await health(port);
    return inst;
  }
  const name = `gnome-e2e-holywisp-${kind}-${process.pid}`;
  const lockdown = ['--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--ulimit', 'nofile=65536:65536', '--user', '65534:65534'];
  let dockerArgs;
  if (HOLYWISP.image) {
    // The packaged image already contains /etc/holywisp/holywisp.conf; mounting gnome.conf over it keeps the
    // checked-in config authoritative.
    dockerArgs = ['run', '-d', '--name', name, ...lockdown, ...mounts, HOLYWISP.image, ...args];
  } else {
    if (!fs.existsSync(HOLYWISP.bin)) {
      throw new Error(`HolyWisp binary not found at ${HOLYWISP.bin}. Build it with services/holywisp/fetch-build.sh or set HOLYWISP_BIN / HOLYWISP_IMAGE.`);
    }
    dockerArgs = ['run', '-d', '--name', name, ...lockdown, ...mounts, '-v', `${path.resolve(HOLYWISP.bin)}:/opt/holywisp/holywisp:ro`, '--entrypoint', '/opt/holywisp/holywisp', alpineImage(), ...args];
  }
  await run('docker', ['rm', '-f', name]).catch(() => {});
  await run('docker', dockerArgs);
  const inst = {
    kind,
    port,
    name,
    stop: async () => { await run('docker', ['rm', '-f', name]).catch(() => {}); },
    logs: async () => { try { const r = await run('docker', ['logs', name]); return r.stdout + r.stderr; } catch (e) { return String(e.stderr || e.message); } },
  };
  instances.push(inst);
  onCleanup(async () => {
    try {
      const dir = process.env.SPIKE_RUN_DIR || RESULTS_DIR;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `holywisp-${kind}.log`), await inst.logs());
    } catch { /* best effort */ }
    await inst.stop();
  });
  await waitPort(port);
  await health(port);
  return inst;
}
