// `run.mjs --check` (docs/WAVE-D.md §3.2): the fixed request list against gnome-server and the Node baseline,
// then 64 MiB of pseudo-random bytes through each gateway to the echo, compared by SHA-256.
import { spawn } from 'node:child_process';
import { cases, rawRequest, pickFiles, compare, normalizer, jsonShape } from './equivalence.mjs';
import { startConfig, PORTS } from './servers.mjs';

async function sha(loadgen, target) {
  return new Promise((resolve) => {
    const p = spawn(loadgen, ['wisp', 'sha', '--ticket-api', `http://127.0.0.1:${PORTS.app}`, '--target', target, '--bytes', String(64 << 20)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch {
        resolve({ equal: false, error: err.slice(-300) });
      }
    });
  });
}

/** Runs the check with one server up at a time (both use the lane's ports). */
export async function runCheck({ common, distDir, loadgen, target }) {
  const files = pickFiles(distDir);
  const ctx = { app: PORTS.app, proxy: PORTS.proxy, appOrigin: `http://127.0.0.1:${PORTS.app}`, proxyOrigin: `http://127.0.0.1:${PORTS.proxy}`, files, profile: 'bench-vpn' };
  const responses = {};
  const shas = [];
  for (const cfg of ['rust', 'node1']) {
    const srv = await startConfig(cfg, common);
    try {
      const state = {};
      responses[cfg] = [];
      for (const c of cases(ctx)) {
        const r = await rawRequest(c.port, c.build(state));
        c.after?.(r, state);
        responses[cfg].push({ name: c.name, r });
      }
      const s = await sha(loadgen, target);
      shas.push({ config: cfg, equal: s.equal === true, sent: s.sent_sha256, echoed: s.echo_sha256, error: s.error });
    } finally {
      await srv.stop();
    }
  }
  const n = normalizer(ctx.appOrigin, ctx.proxyOrigin);
  const diffs = [];
  for (let i = 0; i < responses.rust.length; i++) {
    const x = responses.rust[i].r;
    const y = responses.node1[i].r;
    const d = compare(x, y, n, n);
    if (jsonShape(x) !== jsonShape(y)) d.push(`JSON body keys: ${jsonShape(x)} ≠ ${jsonShape(y)}`);
    if (d.length) diffs.push({ name: responses.rust[i].name, diffs: d });
  }
  const sameSha = shas.length === 2 && shas.every((s) => s.equal) && shas[0].sent === shas[1].sent;
  return { pass: !diffs.length && sameSha, cases: responses.rust.length, equivalent: responses.rust.length - diffs.length, diffs, sha: shas, statuses: responses.rust.map((x, i) => [x.name, x.r.status, responses.node1[i].r.status]) };
}
