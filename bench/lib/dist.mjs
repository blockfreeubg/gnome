// The bench's static tree. Until d2a's release dist/ exists (docs/WAVE-D.md §2.4), the harness copies a plain
// `npm run build` output and adds .br/.gz siblings itself (Node zlib, brotli q11 / gzip -9, text types ≥ 1 KiB,
// kept only when smaller), labelled "plain build + harness siblings" in results.json. A dist that already has
// siblings (the release build) is used as it is.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TEXT = /\.(js|mjs|cjs|css|html|json|map|svg|wasm|webmanifest|txt|xml)$/i;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export function hasSiblings(dist) {
  return walk(dist).some((f) => f.endsWith('.br'));
}

/** Returns {dir, label}. `scratch` is the lane's scratch directory. */
export function prepareDist(src, scratch) {
  if (!existsSync(path.join(src, 'index.html'))) throw new Error(`${src}: no index.html (build the frontend first)`);
  if (hasSiblings(src)) return { dir: src, label: 'release dist (precompressed siblings present)' };
  const dir = path.join(scratch, 'dist-bench');
  const stamp = path.join(dir, '.bench-source');
  const srcStamp = `${src} ${statSync(path.join(src, 'index.html')).mtimeMs} ${walk(src).length}`;
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === srcStamp) return { dir, label: 'plain build + harness siblings' };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(src, dir, { recursive: true });
  for (const f of walk(dir)) {
    if (!TEXT.test(f) || statSync(f).size < 1024) continue;
    const data = readFileSync(f);
    const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
    const gz = zlib.gzipSync(data, { level: 9 });
    if (br.length < data.length) writeFileSync(`${f}.br`, br);
    if (gz.length < data.length) writeFileSync(`${f}.gz`, gz);
  }
  writeFileSync(stamp, srcStamp);
  return { dir, label: 'plain build + harness siblings' };
}
