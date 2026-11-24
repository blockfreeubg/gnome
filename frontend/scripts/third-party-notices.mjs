#!/usr/bin/env node
// @ts-nocheck -- plain Node script (no JSDoc types); its behaviour is covered by the Vitest tests next to it.
/**
 * Third-party notices (WAVE-D D11, §4.4): `dist/licenses/THIRD-PARTY-NOTICES.txt` lists every `node_modules` package
 * whose code is in GNOME's chunks (`.vite/gnome-chunks.json`), its worker bundles (`.vite/gnome-worker-chunks.json`)
 * or `sw.js` (`.vite/gnome-sw-chunks.json`), plus the `@fontsource-variable/*` fonts whose files are in the build,
 * each with its name, version, repository, npm tarball URL, license and license text. The vendored engines are not
 * listed here: they keep their own `LICENSE` and `THIRD-PARTY-LICENSES.txt` under `vendor/<dir>/`.
 *
 *   node frontend/scripts/third-party-notices.mjs [--dist DIR] [--out FILE]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRAPHS = ['.vite/gnome-chunks.json', '.vite/gnome-worker-chunks.json', '.vite/gnome-sw-chunks.json'];

/** Licenses a bundled package may carry. `scripts/audit/npm-policy.json` (`allowLicenses`) replaces it when present. */
const DEFAULT_ALLOW = ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'OFL-1.1', 'MPL-2.0', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0'];

export function allowedLicenses(repo = path.resolve(FRONTEND, '..')) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/audit/npm-policy.json'), 'utf8'));
    const list = p.allowLicenses ?? p.allow_licenses ?? p.licenses?.allow;
    if (Array.isArray(list) && list.length) return list;
  } catch {
    /* d4's policy file is optional here */
  }
  return DEFAULT_ALLOW;
}

/** A license expression is allowed when every alternative of an OR, or every part of an AND, is allowed. */
export function licenseAllowed(expr, allow) {
  if (!expr || typeof expr !== 'string') return false;
  const e = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/.test(e)) return e.split(/\s+OR\s+/).some((x) => licenseAllowed(x, allow));
  return e.split(/\s+AND\s+/).every((x) => allow.includes(x.trim()));
}

/** `node_modules/a/node_modules/@s/b/x.js` → `node_modules/a/node_modules/@s/b` (the package directory). */
export function packageDir(moduleId) {
  if (!moduleId || moduleId.startsWith('\0')) return null;
  const id = moduleId.replace(/\\/g, '/').split('?')[0];
  const i = id.lastIndexOf('node_modules/');
  if (i < 0) return null;
  const rest = id.slice(i + 'node_modules/'.length).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  return id.slice(0, i) + 'node_modules/' + name;
}

/** Every package directory (relative to frontend/) found in the chunk graphs; and which graphs are missing. */
export function packagesFromGraphs(dist) {
  const dirs = new Set();
  const missing = [];
  for (const g of GRAPHS) {
    const file = path.join(dist, g);
    if (!fs.existsSync(file)) {
      missing.push(g);
      continue;
    }
    for (const c of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      for (const m of c.modules ?? []) {
        const d = packageDir(m);
        if (d) dirs.add(d.startsWith('/') ? path.relative(FRONTEND, d) : d);
      }
    }
  }
  return { dirs: [...dirs], missing };
}

/** `@fontsource-variable/*` packages (from package.json) whose font files are in `dist/assets/`. */
export function fontPackages(dist, root = FRONTEND) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const assets = fs.existsSync(path.join(dist, 'assets')) ? fs.readdirSync(path.join(dist, 'assets')) : [];
  return Object.keys(pkg.dependencies ?? {})
    .filter((n) => n.startsWith('@fontsource-variable/'))
    .filter((n) => {
      const family = n.split('/')[1];
      return assets.some((a) => a.startsWith(`${family}-`) && /\.(woff2?|ttf)$/.test(a));
    })
    .map((n) => `node_modules/${n}`);
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function repoUrl(r) {
  if (!r) return '(none recorded)';
  const u = typeof r === 'string' ? r : r.url;
  return (u ?? '(none recorded)').replace(/^git\+/, '');
}

/** One record per package directory; throws on a missing license file or a license outside the allow-list. */
export function describe(dirs, { root = FRONTEND, lock = null, allow = allowedLicenses() } = {}) {
  const lockPkgs = (lock ?? JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))).packages ?? {};
  const errors = [];
  const out = new Map();
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    const pj = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    const key = `${pj.name}@${pj.version}`;
    if (out.has(key)) continue;
    const license = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? null;
    const files = fs.readdirSync(abs).filter((f) => LICENSE_FILE.test(f)).sort();
    if (!files.length) errors.push(`${key}: no license file in ${dir}`);
    if (!licenseAllowed(license, allow)) errors.push(`${key}: license ${license ?? '(none)'} is not in the allow-list`);
    const texts = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(abs, f), 'utf8').replace(/\r\n/g, '\n').trimEnd() }));
    out.set(key, {
      name: pj.name,
      version: pj.version,
      license,
      repository: repoUrl(pj.repository),
      tarball: lockPkgs[dir]?.resolved ?? '(not in package-lock.json)',
      integrity: lockPkgs[dir]?.integrity ?? null,
      texts,
    });
  }
  if (errors.length) throw new Error(`third-party notices:\n  ${errors.join('\n  ')}`);
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1));
}

export function render(pkgs, { incomplete = [] } = {}) {
  const lines = [
    'GNOME: third-party notices for the JavaScript and fonts bundled into GNOME\'s own files',
    '',
    'GNOME is free software under the GNU Affero General Public License, version 3 only (/licenses/ holds the text',
    'in the release bundle; About names the source). The packages below are bundled (minified) into GNOME\'s',
    'scripts, its worker bundles, its service worker or its styles. The proxy engines and transports under /vendor/',
    'are served unmodified with their own LICENSE and THIRD-PARTY-LICENSES.txt next to them.',
    '',
  ];
  if (incomplete.length) lines.push(`NOTE: incomplete: chunk graph(s) missing from this build: ${incomplete.join(', ')}`, '');
  for (const p of pkgs) {
    lines.push('='.repeat(78), `${p.name} ${p.version}`, `License: ${p.license}`, `Repository: ${p.repository}`, `Tarball: ${p.tarball}`, '');
    for (const t of p.texts) lines.push(`--- ${t.file} ---`, t.text, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Writes the notices file; returns what it found (for postbuild's build.json). */
export function writeNotices(dist, out = path.join(dist, 'licenses/THIRD-PARTY-NOTICES.txt')) {
  const { dirs, missing } = packagesFromGraphs(dist);
  const pkgs = describe([...dirs, ...fontPackages(dist)]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, render(pkgs, { incomplete: missing }));
  return { file: path.relative(dist, out), packages: pkgs.map((p) => `${p.name}@${p.version}`), incomplete: missing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const dist = path.resolve(opt('--dist') ?? process.env.GNOME_DIST_DIR ?? path.join(FRONTEND, 'dist'));
  const r = writeNotices(dist, opt('--out') ? path.resolve(opt('--out')) : undefined);
  console.log(`${r.file}: ${r.packages.length} packages${r.incomplete.length ? ` (incomplete: ${r.incomplete.join(', ')})` : ''}`);
}
