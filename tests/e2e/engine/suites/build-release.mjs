// Release build rows (WAVE-D §4.7, BR-rows), standalone:
//
//   node tests/e2e/engine/suites/build-release.mjs [--dist <release dist>] [--from <npm run build output>]
//
// Without --dist it copies a plain build (--from, default frontend/dist) twice into its work directory and runs
// `postbuild.mjs --release` on both copies with a fixed GNOME_BUILD_ID and SOURCE_DATE_EPOCH (BR8 compares them).
// BR4 starts a real gnome-server on 127.0.0.1 (BACKEND_E2E_PORT_BASE; GNOME_SERVER_BIN or the cargo target dir).
// Not here: BR9 (browsers behind the HTTPS front) — the integration step's.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, cleanupAll, startGnomeServer, workDir, writeResults, summarize } from './backend-lib.mjs';

export const standalone = true;

export async function run(ctx) {
  ctx.record({ test: 'BR release build', result: 'skip', notes: 'run standalone: node tests/e2e/engine/suites/build-release.mjs' });
}

const FRONTEND = path.join(REPO, 'frontend');
const POSTBUILD = path.join(FRONTEND, 'scripts/postbuild.mjs');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function postbuild(dist, args) {
  const env = { ...process.env, GNOME_BUILD_ID: '0.0.0+br-suite', SOURCE_DATE_EPOCH: '1700000000' };
  return spawnSync(process.execPath, [POSTBUILD, '--dist', dist, ...args], { env, encoding: 'utf8' });
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const dir = workDir('build-release');
  const rows = [];
  const record = (r) => rows.push({ browser: 'none', ...r });
  const check = (test, ok, notes = '') => record({ test, result: ok ? 'pass' : 'fail', notes });

  let dist = opt('--dist') && path.resolve(opt('--dist'));
  let second = null;
  if (!dist) {
    const from = path.resolve(opt('--from') ?? path.join(FRONTEND, 'dist'));
    if (!fs.existsSync(path.join(from, 'index.html'))) throw new Error(`${from}: no build (cd frontend && npm run build)`);
    dist = path.join(dir, 'dist-a');
    second = path.join(dir, 'dist-b');
    for (const d of [dist, second]) {
      fs.rmSync(d, { recursive: true, force: true });
      fs.cpSync(from, d, { recursive: true });
      // A plain build may carry siblings from an earlier postbuild run; start from the identity files.
      for (const f of walk(d)) if (/\.(br|gz)$/.test(f) || f.startsWith('.gnome/')) fs.rmSync(path.join(d, f));
      const r = postbuild(d, ['--release']);
      if (r.status !== 0) throw new Error(`postbuild --release failed:\n${r.stdout}${r.stderr}`);
    }
  }
  const files = walk(dist);

  // BR1: no map anywhere, no sourceMappingURL in GNOME's own files.
  const maps = files.filter((f) => f.endsWith('.map'));
  const own = files.filter((f) => !f.startsWith('vendor/') && /\.(m?js|css|html)$/.test(f));
  const smu = own.filter((f) => /sourceMappingURL=/.test(fs.readFileSync(path.join(dist, f), 'utf8')));
  check('BR1 no source maps; no sourceMappingURL in GNOME files', !maps.length && !smu.length, `${maps.length} maps, ${smu.length} files with sourceMappingURL ${smu.slice(0, 3).join(' ')}`);

  // BR2: vendor files byte-identical to node_modules; removed files are exactly the packages' maps.
  const { vendorPackages } = await import(path.join(FRONTEND, 'scripts/copy-vendor.mjs'));
  let differ = [];
  let missingMaps = [];
  for (const p of vendorPackages()) {
    const vdir = path.join(dist, 'vendor', p.dir);
    for (const f of walk(vdir)) {
      if (/\.(br|gz)$/.test(f) || ['LICENSE', 'THIRD-PARTY-LICENSES.txt'].includes(f)) continue;
      const src = path.join(FRONTEND, 'node_modules', p.pkg, p.from, f);
      if (!fs.existsSync(src) || !fs.readFileSync(src).equals(fs.readFileSync(path.join(vdir, f)))) differ.push(`${p.dir}/${f}`);
    }
    const srcDir = path.join(FRONTEND, 'node_modules', p.pkg, p.from);
    if (fs.existsSync(srcDir)) {
      for (const f of walk(srcDir).filter((x) => x.endsWith('.map'))) if (fs.existsSync(path.join(vdir, f))) missingMaps.push(`${p.dir}/${f}`);
    }
  }
  check('BR2 vendor files byte-identical; only their maps removed', !differ.length && !missingMaps.length, `${differ.length} differing ${differ.slice(0, 3).join(' ')}; ${missingMaps.length} maps left`);

  // BR3: postbuild --check.
  const c = postbuild(dist, ['--check']);
  check('BR3 postbuild --check (siblings complete and decompress; none for engine/*.html)', c.status === 0 && !files.some((f) => /^engine\/[^/]*\.html\.(br|gz)$/.test(f)), (c.stderr || '').trim().slice(0, 300));

  // BR5: build-time budgets (report-only until d1a rebases them, D26).
  const budgets = JSON.parse(fs.readFileSync(path.join(dist, '.gnome/build.json'), 'utf8')).budgets ?? [];
  const over = budgets.filter((b) => b.over);
  record({ test: 'BR5 build-time budgets', result: over.some((b) => b.enforce) ? 'fail' : 'pass', notes: budgets.map((b) => `${b.id} ${b.value}/${b.ceiling}${b.over ? (b.enforce ? ' OVER' : ' over(report-only)') : ''}`).join('; ') });

  // BR6: release hygiene of served files.
  const bad = [];
  for (const f of files) {
    if (f.startsWith('e2e-driver/') || f.includes('/e2e-driver/')) bad.push(`${f}: e2e driver`);
    if (/\.(br|gz|png|jpg|webp|avif|ico|woff2?|wasm)$/.test(f)) continue;
    const t = fs.readFileSync(path.join(dist, f), 'utf8');
    if (/(?<![\w.-])(\/home\/[a-z_][a-z0-9_-]*\/|\/root\/|\/tmp\/[a-z])/.test(t) && !f.startsWith('vendor/')) bad.push(`${f}: build path`);
    if (/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|_authToken\s*=/.test(t)) bad.push(`${f}: secret pattern`);
  }
  check('BR6 release hygiene (no e2e driver, build paths or secrets in served files)', !bad.length, bad.slice(0, 5).join('; '));

  // BR7: notices file and vendor licenses.
  const notices = path.join(dist, 'licenses/THIRD-PARTY-NOTICES.txt');
  const nt = fs.existsSync(notices) ? fs.readFileSync(notices, 'utf8') : '';
  const { packagesFromGraphs } = await import(path.join(FRONTEND, 'scripts/third-party-notices.mjs'));
  const { dirs, missing } = packagesFromGraphs(dist);
  const names = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(FRONTEND, d, 'package.json'), 'utf8')).name);
  const absent = names.filter((n) => !nt.includes(`\n${n} `));
  const vendorLic = fs.readdirSync(path.join(dist, 'vendor')).filter((d) => !['LICENSE', 'THIRD-PARTY-LICENSES.txt'].every((f) => fs.existsSync(path.join(dist, 'vendor', d, f))));
  const fonts = (nt.match(/License: OFL-1\.1/g) ?? []).length;
  record({
    test: 'BR7 notices list every bundled package; vendor licenses present; fonts OFL',
    result: !absent.length && !vendorLic.length && fonts > 0 && nt ? (missing.length ? 'expectFail' : 'pass') : 'fail',
    notes: `${names.length} packages from the graphs, ${absent.length} absent ${absent.join(' ')}; vendor dirs without licenses: ${vendorLic.join(' ') || 'none'}; ${fonts} OFL fonts${missing.length ? `; graphs missing: ${missing.join(' ')}` : ''}`,
  });

  // BR8: deterministic manifest.
  if (second) {
    const a = fs.readFileSync(path.join(dist, '.gnome/files.json'), 'utf8');
    const b = fs.readFileSync(path.join(second, '.gnome/files.json'), 'utf8');
    check('BR8 two release postbuilds give identical .gnome/files.json', a === b, `${Object.keys(JSON.parse(a)).length} files`);
  }

  // BR4: a real gnome-server serves the siblings.
  try {
    const srv = await startGnomeServer({ dir, staticDir: dist, label: 'br4' });
    const asset = files.find((f) => f.startsWith('assets/') && f.endsWith('.js') && files.includes(`${f}.br`) && files.includes(`${f}.gz`));
    const problems = [];
    let etag = null;
    for (const [enc, want] of [['br', 'br'], ['gzip', 'gzip'], ['identity', null]]) {
      const r = await fetch(`${srv.appOrigin}/${asset}`, { headers: { 'accept-encoding': enc } });
      await r.arrayBuffer();
      const ce = r.headers.get('content-encoding');
      if ((ce ?? null) !== want) problems.push(`${enc}: content-encoding ${ce}`);
      if (!/accept-encoding/i.test(r.headers.get('vary') ?? '')) problems.push(`${enc}: no Vary`);
      const tag = r.headers.get('etag');
      if (want === 'br' && !/-br"$/.test(tag ?? '')) problems.push(`br etag ${tag}`);
      const r304 = await fetch(`${srv.appOrigin}/${asset}`, { headers: { 'accept-encoding': enc, 'if-none-match': tag } });
      await r304.arrayBuffer();
      if (r304.status !== 304) problems.push(`${enc}: revalidation ${r304.status}`);
      if (want === 'br') etag = tag;
    }
    const eng = await fetch(`${srv.appOrigin}/engine/`, { headers: { 'accept-encoding': 'br, gzip' } });
    await eng.arrayBuffer();
    if (eng.headers.get('content-encoding')) problems.push(`/engine/ encoded ${eng.headers.get('content-encoding')}`);
    for (const p of ['/.vite/gnome-chunks.json', '/.gnome/files.json']) {
      const r = await fetch(`${srv.appOrigin}${p}`);
      await r.arrayBuffer();
      if (r.status !== 404) problems.push(`${p} ${r.status}`);
    }
    const lic = await fetch(`${srv.appOrigin}/licenses/THIRD-PARTY-NOTICES.txt`);
    await lic.arrayBuffer();
    if (lic.status !== 200) problems.push(`notices ${lic.status}`);
    check('BR4 gnome-server serves br/gzip/identity with ETag variants, 304s, /engine/ unencoded, dot-dirs 404, notices 200', !problems.length, `${asset} ${etag}; ${problems.join('; ')}`);
  } catch (e) {
    record({ test: 'BR4 gnome-server serves the siblings', result: 'fail', notes: String(e.message).slice(0, 300) });
  }
  record({ test: 'BR9 release dist/ in browsers behind the HTTPS front', result: 'skip', notes: 'not run by d-ship (left to the Wave D integration step)' });

  writeResults(dir, 'build-release', rows);
  const s = summarize(rows);
  for (const r of rows) console.log(`${r.result.padEnd(10)} ${r.test}  ${String(r.notes ?? '').slice(0, 200)}`);
  console.log(`build-release: ${s.pass} pass, ${s.fail} fail, ${s.skip} skip (${dir})`);
  return s.fail ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(async (code) => {
      await cleanupAll();
      process.exit(code);
    })
    .catch(async (e) => {
      console.error(e);
      await cleanupAll();
      process.exit(1);
    });
}
