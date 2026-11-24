#!/usr/bin/env node
/**
 * The licenses bundle of a release artifact and image (WAVE-D §4.4, D11): writes `<out>/` =
 *
 *   GNOME-AGPL-3.0.txt          GNOME's license
 *   SOURCE.txt                  where the Corresponding Source is (D27) and the AGPL §13 rule for operators
 *   gnome-server/rust-std.txt   the Rust standard library's notice (std, core, alloc: MIT OR Apache-2.0)
 *   gnome-server/LICENSE.musl   musl's COPYRIGHT (the binary is static musl)
 *   rust-crates.txt             every crate of gnome-server's normal dependency graph for the target, with its texts
 *   npm-bundled.txt             the notices file of the release dist/ (licenses/THIRD-PARTY-NOTICES.txt)
 *   vendor/<dir>/{LICENSE,THIRD-PARTY-LICENSES.txt,SOURCE.txt}   the vendored engines, copied unchanged
 *   sqlite.txt                  SQLite's public-domain dedication (bundled by libsqlite3-sys)
 *   holywisp/{LICENSE,LICENSE.musl,BUILDINFO}                    with --holywisp DIR
 *
 *   node scripts/third-party-licenses.mjs --target <triple> --dist <release dist> --out <dir>
 *        [--cargo-metadata <json> --crate-src <dir>] [--rust-std <dir>] [--musl <file>] [--holywisp <dir>]
 *        [--source-url URL] [--source-info <file>]
 *
 * Without --cargo-metadata it runs `cargo metadata` here; --crate-src holds `<name>-<version>/` directories with each
 * crate's license files (the Docker build copies them from its registry, so this runs without cargo).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPDX_DIR = path.join(REPO, 'frontend/scripts/licenses');
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    o[a.slice(2)] = argv[++i];
  }
  for (const k of ['target', 'dist', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  return o;
}

/** The normal-dependency closure of `root` (package name), excluding workspace members. */
export function crateGraph(meta, root = 'gnome-server') {
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const ws = new Set(meta.workspace_members);
  const start = meta.packages.find((p) => p.name === root && ws.has(p.id));
  if (!start) throw new Error(`${root} is not a workspace member in the metadata`);
  const seen = new Set([start.id]);
  const queue = [start.id];
  while (queue.length) {
    const n = nodes.get(queue.shift());
    for (const d of n?.deps ?? []) {
      const normal = (d.dep_kinds ?? [{ kind: null }]).some((k) => k.kind === null);
      if (normal && !seen.has(d.pkg)) {
        seen.add(d.pkg);
        queue.push(d.pkg);
      }
    }
  }
  return [...seen]
    .filter((id) => !ws.has(id))
    .map((id) => byId.get(id))
    .sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
}

function spdxIds(expr) {
  return [...new Set((expr ?? '').replace(/[()]/g, ' ').split(/\s+/).filter((t) => t && !['AND', 'OR', 'WITH'].includes(t)))];
}

function licenseTexts(pkg, crateSrc) {
  const dir = crateSrc ? path.join(crateSrc, `${pkg.name}-${pkg.version}`) : path.dirname(pkg.manifest_path);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort() : [];
  if (files.length) return files.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
  // No license file shipped: the SPDX texts of its expression.
  const out = [];
  const missing = [];
  for (const id of spdxIds(pkg.license)) {
    const f = path.join(SPDX_DIR, `${id}.txt`);
    if (fs.existsSync(f)) out.push({ file: `${id} (SPDX text; the crate ships no license file)`, text: fs.readFileSync(f, 'utf8').trimEnd() });
    else missing.push(id);
  }
  if (!out.length || missing.length) throw new Error(`${pkg.name} ${pkg.version}: no license file and no SPDX text for ${missing.join(', ') || pkg.license}`);
  return out;
}

export function rustCratesTxt(crates, crateSrc, target) {
  const lines = [`Rust crates linked into gnome-server for ${target} (cargo metadata, normal dependencies; ${crates.length} crates)`, ''];
  for (const c of crates) {
    lines.push('='.repeat(78), `${c.name} ${c.version}`, `License: ${c.license ?? c.license_file ?? '(none)'}`, `Source: ${c.repository ?? c.source ?? ''}`, '');
    for (const t of licenseTexts(c, crateSrc)) lines.push(`--- ${t.file} ---`, t.text, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const SQLITE = `SQLite (bundled into gnome-server by libsqlite3-sys)

The author disclaims copyright to this source code. In place of a legal notice, here is a blessing:

    May you do good and not evil.
    May you find forgiveness for yourself and forgive others.
    May you share freely, never taking more than you give.

SQLite is in the public domain: https://sqlite.org/copyright.html
`;

function main() {
  const o = args(process.argv.slice(2));
  const out = path.resolve(o.out);
  const dist = path.resolve(o.dist);
  fs.mkdirSync(path.join(out, 'gnome-server'), { recursive: true });
  fs.copyFileSync(path.join(SPDX_DIR, 'AGPL-3.0.txt'), path.join(out, 'GNOME-AGPL-3.0.txt'));

  const meta = o['cargo-metadata']
    ? JSON.parse(fs.readFileSync(o['cargo-metadata'], 'utf8'))
    : JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', o.target], { cwd: REPO, maxBuffer: 256 << 20 }));
  const crates = crateGraph(meta);
  fs.writeFileSync(path.join(out, 'rust-crates.txt'), rustCratesTxt(crates, o['crate-src'], o.target));

  if (o['rust-std']) {
    const d = o['rust-std'];
    const ver = fs.existsSync(path.join(d, 'VERSION')) ? fs.readFileSync(path.join(d, 'VERSION'), 'utf8').trim() : 'unknown';
    const parts = [`The Rust standard library (std, core, alloc), linked into gnome-server: MIT OR Apache-2.0`, `Toolchain: ${ver}`, ''];
    for (const f of ['MIT.txt', 'Apache-2.0.txt']) parts.push(`--- ${f} ---`, fs.readFileSync(path.join(d, f), 'utf8').trimEnd(), '');
    fs.writeFileSync(path.join(out, 'gnome-server/rust-std.txt'), `${parts.join('\n').trimEnd()}\n`);
  } else {
    const parts = ['The Rust standard library (std, core, alloc), linked into gnome-server: MIT OR Apache-2.0', ''];
    for (const f of ['MIT.txt', 'Apache-2.0.txt']) parts.push(`--- ${f} ---`, fs.readFileSync(path.join(SPDX_DIR, f), 'utf8').trimEnd(), '');
    fs.writeFileSync(path.join(out, 'gnome-server/rust-std.txt'), `${parts.join('\n').trimEnd()}\n`);
  }
  if (o.musl) fs.copyFileSync(o.musl, path.join(out, 'gnome-server/LICENSE.musl'));
  else if (o.target.endsWith('-musl')) throw new Error('--musl <COPYRIGHT> is required for a musl target');

  const notices = path.join(dist, 'licenses/THIRD-PARTY-NOTICES.txt');
  if (!fs.existsSync(notices)) throw new Error(`${notices} is missing (run postbuild.mjs --release first)`);
  fs.copyFileSync(notices, path.join(out, 'npm-bundled.txt'));

  // Vendored engines: their files unchanged, plus the revision record (D27).
  let sources = {};
  try {
    sources = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/third-party-sources.json'), 'utf8')).packages ?? {};
  } catch {
    sources = {};
  }
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'frontend/package-lock.json'), 'utf8')).packages ?? {};
  const vendor = path.join(dist, 'vendor');
  for (const dir of fs.existsSync(vendor) ? fs.readdirSync(vendor).sort() : []) {
    const dst = path.join(out, 'vendor', dir);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ['LICENSE', 'THIRD-PARTY-LICENSES.txt']) {
      if (!fs.existsSync(path.join(vendor, dir, f))) throw new Error(`vendor/${dir}/${f} is missing`);
      fs.copyFileSync(path.join(vendor, dir, f), path.join(dst, f));
    }
    const entry = Object.entries(sources).find(([, v]) => v.vendorDir === dir);
    const [key, src] = entry ?? [null, null];
    const pkgName = key ? key.replace(/@[^@]*$/, '') : null;
    const l = pkgName ? lock[`node_modules/${pkgName}`] : null;
    fs.writeFileSync(
      path.join(dst, 'SOURCE.txt'),
      [
        `vendor/${dir}: ${key ?? '(no entry in scripts/third-party-sources.json)'}`,
        `npm tarball: ${l?.resolved ?? '(unknown)'}`,
        `integrity:   ${l?.integrity ?? '(unknown)'}`,
        `repository:  ${src?.repository ?? '(unknown)'}`,
        `commit:      ${src?.commit ?? '(not verified)'}`,
        `tree:        ${src?.tree ?? '(not verified)'}`,
        src?.verified ? '' : 'The upstream revision of this package is not verified yet; the npm tarball above is the exact code served.',
      ].join('\n').trimEnd() + '\n',
    );
  }

  fs.writeFileSync(path.join(out, 'sqlite.txt'), SQLITE);
  if (o.holywisp) {
    fs.mkdirSync(path.join(out, 'holywisp'), { recursive: true });
    for (const f of ['LICENSE', 'LICENSE.musl', 'BUILDINFO']) fs.copyFileSync(path.join(o.holywisp, f), path.join(out, 'holywisp', f));
  }
  const info = o['source-info'] && fs.existsSync(o['source-info']) ? fs.readFileSync(o['source-info'], 'utf8').trimEnd() : '';
  fs.writeFileSync(
    path.join(out, 'SOURCE.txt'),
    [
      'GNOME is free software: GNU Affero General Public License, version 3 only (GNOME-AGPL-3.0.txt).',
      '',
      `Corresponding Source of this build: ${o['source-url'] || '(no default source URL compiled into this build)'}`,
      info,
      '',
      'If you run a modified GNOME for other people over a network, AGPL-3.0 section 13 requires you to offer them the',
      'Corresponding Source of your version (set GNOME_SOURCE_URL; About links to it).',
    ].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n',
  );
  console.log(`licenses bundle: ${out} (${crates.length} crates)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`third-party-licenses: ${e.message}`);
    process.exit(1);
  }
}
