#!/usr/bin/env node
// @ts-nocheck -- plain Node script (no JSDoc types); its behaviour is covered by the Vitest tests next to it.
/**
 * postbuild (WAVE-D §4.1): what happens to `dist/` after `npm run build`.
 *
 *   node frontend/scripts/postbuild.mjs [--dist DIR] [--release] [--check] [--allow-budget-overrun "<reason>"]
 *
 * 1. Maps (--release, D9): delete vendor/**\/*.map; any other .map file is an error (GNOME's code has none).
 * 2. Precompression (D8): .br (quality 11, window 24) and .gz (level 9) siblings for text files ≥ 1 KiB that save
 *    ≥ 10 %, never engine/*.html or .map; with --release, files under vendor/ get only .br. Every sibling is
 *    decompressed and compared with its file; an existing sibling that does not match is an error.
 * 3. Manifests: with SOURCE_DATE_EPOCH, every mtime is set to it; then .gnome/files.json and .gnome/build.json.
 * 4. Notices (D11): licenses/THIRD-PARTY-NOTICES.txt.
 * 5. Budgets (§7, build-time rows): printed; an enforced overrun exits 1 unless --allow-budget-overrun.
 *
 * --check verifies an existing release dist/ (the same rules as assertions; nothing is written).
 * Exit: 0 ok, 1 a check or an enforced budget failed, 2 usage.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FRONTEND, defaultDist, report } from './bundle-report.mjs';
import { writeNotices, packagesFromGraphs } from './third-party-notices.mjs';

export const TEXT_EXT = ['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt', '.wasm'];
export const MIN_SIZE = 1024;
export const MIN_SAVING = 0.1;
const REPO = path.resolve(FRONTEND, '..');

const brotli = (buf) =>
  zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  });
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });

/** Walk `dir` (relative, '/'-separated paths, sorted). Dot-directories are included (they are ours: .vite, .gnome). */
export function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/** Whether `rel` (a dist-relative path of `size` bytes) may get siblings, and which. */
export function siblingKinds(rel, size, { release = false } = {}) {
  if (rel.endsWith('.br') || rel.endsWith('.gz') || rel.endsWith('.map')) return [];
  if (rel.startsWith('.vite/') || rel.startsWith('.gnome/')) return [];
  if (/^engine\/[^/]*\.html$/.test(rel)) return [];
  const base = rel.split('/').pop();
  const text = TEXT_EXT.includes(path.extname(rel).toLowerCase()) || /^LICEN[CS]E/i.test(base);
  if (!text || size < MIN_SIZE) return [];
  return release && rel.startsWith('vendor/') ? ['br'] : ['br', 'gz'];
}

/** Compress `buf` for each kind; keep a sibling only when it saves ≥ 10 %. Verified by round trip. */
export function compressOne(buf, kinds) {
  const out = {};
  for (const k of kinds) {
    const c = k === 'br' ? brotli(buf) : gzip(buf);
    if (c.length > buf.length * (1 - MIN_SAVING)) continue;
    const back = k === 'br' ? zlib.brotliDecompressSync(c) : zlib.gunzipSync(c);
    if (!back.equals(buf)) throw new Error(`round trip of the ${k} sibling failed`);
    out[k] = c;
  }
  return out;
}

function decompress(kind, buf) {
  return kind === 'br' ? zlib.brotliDecompressSync(buf) : zlib.gunzipSync(buf);
}

// ---- worker thread ---------------------------------------------------------------------------------------------
if (!isMainThread && workerData?.postbuildWorker) {
  parentPort.on('message', ({ id, file, kinds }) => {
    try {
      const buf = fs.readFileSync(file);
      const res = compressOne(buf, kinds);
      parentPort.postMessage({ id, res: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v])) });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e?.message ?? e) });
    }
  });
}

/** Compress jobs on up to 6 worker threads. Returns Map(rel → {br?: Buffer, gz?: Buffer}). */
async function compressAll(dist, jobs) {
  const n = Math.max(1, Math.min(6, os.availableParallelism?.() ?? os.cpus().length, jobs.length));
  const results = new Map();
  if (!jobs.length) return results;
  const workers = Array.from({ length: n }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { postbuildWorker: true } }));
  let next = 0;
  await new Promise((resolve, reject) => {
    let done = 0;
    const feed = (w) => {
      if (next >= jobs.length) return;
      const id = next++;
      w.postMessage({ id, file: path.join(dist, jobs[id].rel), kinds: jobs[id].kinds });
    };
    for (const w of workers) {
      w.on('message', (m) => {
        if (m.error) return reject(new Error(`${jobs[m.id].rel}: ${m.error}`));
        results.set(jobs[m.id].rel, Object.fromEntries(Object.entries(m.res).map(([k, v]) => [k, Buffer.from(v)])));
        if (++done === jobs.length) resolve();
        else feed(w);
      });
      w.on('error', reject);
      feed(w);
    }
  });
  await Promise.all(workers.map((w) => w.terminate()));
  return results;
}

// ---- budgets (§7 build-time rows) --------------------------------------------------------------------------------
/** Built-in ceilings (bytes; KB = 1000 B) of §7; report-only (`enforce: false`) until d1a rebases them (D26). */
export const DEFAULT_BUDGETS = {
  BB1: { what: 'app startup set JS + CSS, gzip', ceiling: 170_000, enforce: false },
  BB2: { what: 'app startup set JS + CSS, brotli', ceiling: 150_000, enforce: false },
  BB3: { what: "engine host's own startup JS, gzip", ceiling: 65_000, enforce: false },
  BB5: { what: 'largest lazy GNOME chunk, gzip', ceiling: 60_000, enforce: false },
  BB7: { what: 'release dist/ on disk', ceiling: 40 * 1024 * 1024, enforce: false },
  BB8: { what: '.map files + sourceMappingURL in GNOME files', ceiling: 0, enforce: true },
};

/** `scripts/budgets.json` (d1a) may override: `{ "build": { "BB1": { "ceiling": <bytes>, "enforce": bool } } }`. */
export function loadBudgets(file = path.join(REPO, 'scripts/budgets.json')) {
  const b = structuredClone(DEFAULT_BUDGETS);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, row] of Object.entries(j.build ?? {})) {
      if (!b[id]) continue;
      if (typeof row.ceiling === 'number') b[id].ceiling = row.ceiling;
      if (typeof row.enforce === 'boolean') b[id].enforce = row.enforce;
    }
  } catch {
    /* no budgets file yet: the defaults above */
  }
  return b;
}

/** Measures the build-time rows on `dist`. */
export function measureBudgets(dist, files, budgets = loadBudgets()) {
  const r = report(dist);
  const app = r.pages.app;
  const engine = r.pages.engine;
  const largestLazy = r.lazy.filter((c) => c.url.startsWith('/assets/') && c.url.endsWith('.js')).reduce((m, c) => Math.max(m, c.gzip), 0);
  const total = files.reduce((a, f) => a + fs.statSync(path.join(dist, f)).size, 0);
  const maps = files.filter((f) => f.endsWith('.map')).length;
  const own = files.filter((f) => !f.startsWith('vendor/') && /\.(m?js|css)$/.test(f));
  const smu = own.filter((f) => /sourceMappingURL=/.test(fs.readFileSync(path.join(dist, f), 'utf8'))).length;
  const values = {
    BB1: app ? app.total.gzip : 0,
    BB2: app ? app.total.br : 0,
    BB3: engine ? engine.js.gzip : 0,
    BB5: largestLazy,
    BB7: total,
    BB8: maps + smu,
  };
  return Object.entries(budgets).map(([id, b]) => ({ id, ...b, value: values[id], over: values[id] > b.ceiling }));
}

// ---- main ------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { dist: defaultDist(), release: false, check: false, overrun: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') o.dist = path.resolve(argv[++i] ?? '');
    else if (a === '--release') o.release = true;
    else if (a === '--check') o.check = true;
    else if (a === '--allow-budget-overrun') o.overrun = argv[++i] ?? '';
    else throw Object.assign(new Error(`unknown argument ${a}`), { usage: true });
  }
  if (o.overrun !== null && !o.overrun.trim()) throw Object.assign(new Error('--allow-budget-overrun needs a reason'), { usage: true });
  return o;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Runs the pipeline (or, with check, verifies it). Returns { ok, problems, removedMaps, siblings, budgets }.
 * `log` receives progress lines.
 * @param {{ dist: string, release?: boolean, check?: boolean, overrun?: string | null, log?: (line: string) => void }} opts
 */
export async function postbuild({ dist, release = false, check = false, overrun = null, log = console.log } = {}) {
  const problems = [];
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error(`${dist} has no index.html (run npm run build first)`);
  if (check) release = true;

  // 1. maps
  const removedMaps = [];
  for (const rel of walk(dist).filter((f) => f.endsWith('.map'))) {
    if (release && rel.startsWith('vendor/')) {
      if (check) problems.push(`map file in a release dist: ${rel}`);
      else {
        fs.rmSync(path.join(dist, rel));
        removedMaps.push(rel);
      }
    } else if (!rel.startsWith('vendor/')) problems.push(`source map of GNOME's own code: ${rel}`);
  }

  // 2. precompression
  let files = walk(dist);
  const set = new Set(files);
  const jobs = [];
  for (const rel of files) {
    const kinds = siblingKinds(rel, fs.statSync(path.join(dist, rel)).size, { release });
    if (kinds.length) jobs.push({ rel, kinds });
  }
  // A sibling whose identity file is gone, or that the rules give no sibling, is stale.
  for (const rel of files.filter((f) => /\.(br|gz)$/.test(f))) {
    const base = rel.slice(0, -3);
    const kind = rel.slice(-2);
    const job = jobs.find((j) => j.rel === base);
    if (!set.has(base)) problems.push(`sibling without its file: ${rel}`);
    else if (!job || !job.kinds.includes(kind)) problems.push(`sibling the rules do not allow: ${rel}`);
  }
  const t0 = Date.now();
  const results = await compressAll(dist, jobs);
  const siblings = {};
  for (const { rel, kinds } of jobs) {
    const want = results.get(rel) ?? {};
    const buf = fs.readFileSync(path.join(dist, rel));
    for (const k of kinds) {
      const sib = `${rel}.${k}`;
      if (set.has(sib)) {
        let back = null;
        try {
          back = decompress(k, fs.readFileSync(path.join(dist, sib)));
        } catch {
          back = null;
        }
        if (!back || !back.equals(buf)) problems.push(`stale or corrupt sibling: ${sib}`);
        else if (!want[k]) problems.push(`sibling that saves < 10 %: ${sib}`);
      } else if (want[k]) {
        if (check) problems.push(`missing sibling: ${sib}`);
        else fs.writeFileSync(path.join(dist, sib), want[k]);
      }
      if (want[k]) siblings[sib] = want[k].length;
    }
  }
  log(`postbuild: ${Object.keys(siblings).length} siblings for ${jobs.length} eligible files in ${Date.now() - t0} ms`);

  // 4. notices (before the manifest, which lists them)
  let notices = null;
  const noticesPath = path.join(dist, 'licenses/THIRD-PARTY-NOTICES.txt');
  if (check) {
    if (!fs.existsSync(noticesPath)) problems.push('licenses/THIRD-PARTY-NOTICES.txt is missing');
    notices = { incomplete: packagesFromGraphs(dist).missing };
  } else {
    try {
      notices = writeNotices(dist, noticesPath);
    } catch (e) {
      problems.push(String(e.message));
    }
    // Its siblings too (it is a plain text file served on the app origin).
    if (fs.existsSync(noticesPath)) {
      const buf = fs.readFileSync(noticesPath);
      for (const k of ['br', 'gz']) fs.rmSync(`${noticesPath}.${k}`, { force: true });
      for (const [k, c] of Object.entries(compressOne(buf, siblingKinds('licenses/THIRD-PARTY-NOTICES.txt', buf.length, { release })))) {
        fs.writeFileSync(`${noticesPath}.${k}`, c);
      }
    }
  }

  // 5. budgets
  files = walk(dist).filter((f) => !f.startsWith('.gnome/'));
  const budgets = measureBudgets(dist, files);
  for (const b of budgets) {
    log(`  ${b.id.padEnd(4)} ${String(b.value).padStart(10)} / ${String(b.ceiling).padStart(10)} ${b.over ? (b.enforce ? 'OVER' : 'over (report-only)') : 'ok'}  ${b.what}`);
  }
  const enforcedOver = budgets.filter((b) => b.over && b.enforce);
  if (enforcedOver.length && overrun === null) problems.push(`budget overrun: ${enforcedOver.map((b) => b.id).join(', ')}`);

  // 3. manifests
  const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : null;
  if (epoch !== null && !Number.isInteger(epoch)) throw new Error('SOURCE_DATE_EPOCH must be an integer');
  const manifest = {};
  for (const rel of files) {
    const p = path.join(dist, rel);
    if (epoch !== null && !check) fs.utimesSync(p, epoch, epoch);
    if (rel.endsWith('.br') || rel.endsWith('.gz')) continue;
    const st = fs.statSync(p);
    const entry = { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), sha256: sha256(fs.readFileSync(p)) };
    for (const k of ['br', 'gz']) if (fs.existsSync(`${p}.${k}`)) entry[k] = fs.statSync(`${p}.${k}`).size;
    manifest[rel] = entry;
  }
  const filesJson = `${JSON.stringify(manifest, null, 1)}\n`;
  const build = {
    buildId: process.env.GNOME_BUILD_ID ?? null,
    release,
    sourceDateEpoch: epoch,
    removedMaps,
    notices: notices ? { packages: notices.packages?.length ?? null, incomplete: notices.incomplete } : null,
    budgets: budgets.map(({ id, value, ceiling, enforce, over }) => ({ id, value, ceiling, enforce, over })),
    budgetOverrunReason: overrun,
  };
  if (check) {
    const existing = path.join(dist, '.gnome/files.json');
    if (!fs.existsSync(existing)) problems.push('.gnome/files.json is missing');
    else if (fs.readFileSync(existing, 'utf8') !== filesJson) problems.push('.gnome/files.json does not match the files');
  } else {
    fs.mkdirSync(path.join(dist, '.gnome'), { recursive: true });
    fs.writeFileSync(path.join(dist, '.gnome/files.json'), filesJson);
    fs.writeFileSync(path.join(dist, '.gnome/build.json'), `${JSON.stringify(build, null, 1)}\n`);
    if (epoch !== null) for (const f of ['files.json', 'build.json']) fs.utimesSync(path.join(dist, '.gnome', f), epoch, epoch);
  }
  return { ok: problems.length === 0, problems, removedMaps, siblings, budgets };
}

if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`postbuild: ${e.message}`);
    process.exit(2);
  }
  postbuild(opts).then(
    (r) => {
      if (r.removedMaps.length) console.log(`postbuild: removed ${r.removedMaps.length} vendor .map files`);
      if (!r.ok) {
        for (const p of r.problems) console.error(`postbuild: ${p}`);
        process.exit(1);
      }
      console.log(`postbuild: ${opts.check ? 'check passed' : 'done'}`);
    },
    (e) => {
      console.error(`postbuild: ${e.message}`);
      process.exit(1);
    },
  );
}
