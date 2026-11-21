#!/usr/bin/env node
/**
 * Copies the pinned engine and transport builds into `<dist>/vendor/<dir>/` (ARCHITECTURE §3, §5.4), the last step of
 * `npm run build`. The list is VENDOR_PACKAGES in src/shared/proxy-origin.ts (read from its source, so there is one
 * list); every file of each package's `from` directory is copied byte for byte (never bundled, minified or
 * obfuscated), the installed version must equal the pin, and each directory gets:
 * - `LICENSE`: the package's own license file, or (for the packages whose tarball ships none: `needsLicenseText`)
 *   the license text the package states, from scripts/licenses/ (AGPL-3.0);
 * - `THIRD-PARTY-LICENSES.txt`: name, version, license and license file of every package the bundle may include (the
 *   package's transitive `dependencies` as installed, e.g. libcurl.js in the libcurl transports, epoxy-tls in the
 *   epoxy transports), plus the GPL-3.0 text when an LGPL-3.0 component is among them (LGPL-3.0 refers to it).
 *
 *   node scripts/copy-vendor.mjs            # into GNOME_DIST_DIR or frontend/dist
 *   node scripts/copy-vendor.mjs --check    # only verify an existing <dist>/vendor/ against node_modules
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_DIR = path.join(FRONTEND, 'scripts', 'licenses');
/** @typedef {{ dir: string, pkg: string, version: string, from: string, license: string, needsLicenseText: boolean }} VendorEntry */
/** @typedef {{ dist: string, root?: string, nodeModules?: string }} VendorTarget */

/** @type {Record<string, string>} */
const LICENSE_TEXTS = { 'AGPL-3.0-only': 'AGPL-3.0.txt', 'AGPL-3.0': 'AGPL-3.0.txt', 'AGPL-3.0-or-later': 'AGPL-3.0.txt' };
const LICENSE_FILE_RE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/**
 * VENDOR_PACKAGES, evaluated from the array literal in src/shared/proxy-origin.ts (plain object literals only).
 * @returns {VendorEntry[]}
 */
export function vendorPackages(root = FRONTEND) {
  const src = readFileSync(path.join(root, 'src', 'shared', 'proxy-origin.ts'), 'utf8');
  const m = /export const VENDOR_PACKAGES: readonly VendorPackage\[\] = \[([\s\S]*?)\n\];/.exec(src);
  if (!m) throw new Error('VENDOR_PACKAGES not found in src/shared/proxy-origin.ts');
  const body = m[1] ?? '';
  if (/[`$()]|=>|function/.test(body)) throw new Error('VENDOR_PACKAGES must stay a list of plain object literals');
  /** @type {VendorEntry[]} */
  const list = new Function(`return [${body}];`)();
  for (const p of list) {
    for (const k of /** @type {const} */ (['dir', 'pkg', 'version', 'from', 'license'])) if (typeof p[k] !== 'string' || !p[k]) throw new Error(`VENDOR_PACKAGES entry without ${k}`);
    if (!/^[a-z0-9-]+$/.test(p.dir)) throw new Error(`bad vendor dir ${p.dir}`);
  }
  return list;
}

/** @param {string} nodeModules @param {string} name */
function pkgDir(nodeModules, name) {
  return path.join(nodeModules, ...name.split('/'));
}

/** @param {string} dir @returns {{ name: string, version: string, license?: unknown, dependencies?: Record<string, string> }} */
function readPkg(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** @param {string} dir */
function licenseFile(dir) {
  const f = readdirSync(dir).find((n) => LICENSE_FILE_RE.test(n) && statSync(path.join(dir, n)).isFile());
  return f ? path.join(dir, f) : null;
}

/** Resolves a dependency the way Node does: next to the requiring package first, then up the tree. */
/** @param {string} fromDir @param {string} name @param {string} nodeModules @returns {string | null} */
function resolveDep(fromDir, name, nodeModules) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir) === path.resolve(path.dirname(nodeModules))) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const top = pkgDir(nodeModules, name);
  return existsSync(path.join(top, 'package.json')) ? top : null;
}

/** The installed transitive `dependencies` of a package (name@version → dir), without the package itself. */
/** @param {string} dir @param {string} nodeModules @returns {Array<[string, string]>} */
export function bundledDependencies(dir, nodeModules) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @param {string} d */
  const walk = (d) => {
    const deps = Object.keys(readPkg(d).dependencies ?? {});
    for (const name of deps) {
      const depDir = resolveDep(d, name, nodeModules);
      if (!depDir) continue;
      const pkg = readPkg(depDir);
      const id = `${pkg.name}@${pkg.version}`;
      if (seen.has(id)) continue;
      seen.set(id, depDir);
      walk(depDir);
    }
  };
  walk(dir);
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** @param {string} dir @param {string} [base] @returns {string[]} */
function listFiles(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else if (st.isFile()) out.push(path.relative(base, p));
  }
  return out.sort();
}

/** @param {string} file */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** @param {VendorEntry} entry @param {string} srcDir @param {string} nodeModules */
function thirdParty(entry, srcDir, nodeModules) {
  const deps = bundledDependencies(srcDir, nodeModules);
  const parts = [
    `Third-party components that ${entry.pkg}@${entry.version} (served unmodified from /vendor/${entry.dir}/) may include,`,
    'from its installed dependency tree. Each entry gives the package, its declared license and its license file.',
    '',
  ];
  let lgpl = false;
  for (const [id, dir] of deps) {
    const pkg = readPkg(dir);
    const license = typeof pkg.license === 'string' ? pkg.license : 'see the license file';
    if (/LGPL-3\.0/.test(license)) lgpl = true;
    parts.push('='.repeat(100), `${id}  (${license})`, '='.repeat(100));
    const lf = licenseFile(dir);
    parts.push(lf ? readFileSync(lf, 'utf8').trimEnd() : `No license file in the package; its package.json states: ${license}.`, '');
  }
  if (!deps.length) parts.push('None: the package has no runtime dependencies.', '');
  if (lgpl) {
    parts.push('='.repeat(100), 'GNU General Public License v3.0 (referenced by the LGPL-3.0 above)', '='.repeat(100));
    parts.push(readFileSync(path.join(LICENSE_DIR, 'GPL-3.0.txt'), 'utf8').trimEnd(), '');
  }
  return `${parts.join('\n')}\n`;
}

/** Copies every VENDOR_PACKAGES entry into `<dist>/vendor/`. Returns what it copied (for logs and tests). */
/** @param {VendorTarget} target */
export function copyVendor({ dist, root = FRONTEND, nodeModules = path.join(root, 'node_modules') }) {
  const copied = [];
  for (const entry of vendorPackages(root)) {
    const dir = pkgDir(nodeModules, entry.pkg);
    if (!existsSync(path.join(dir, 'package.json'))) throw new Error(`${entry.pkg} is not installed (npm ci in frontend/)`);
    const pkg = readPkg(dir);
    if (pkg.version !== entry.version) throw new Error(`${entry.pkg} is ${pkg.version}, VENDOR_PACKAGES pins ${entry.version}`);
    const src = path.join(dir, entry.from);
    const dest = path.join(dist, 'vendor', entry.dir);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    const own = licenseFile(dir);
    if (entry.needsLicenseText || !own) {
      const text = LICENSE_TEXTS[entry.license];
      if (!text) throw new Error(`${entry.pkg}: no license text for ${entry.license} in scripts/licenses/`);
      writeFileSync(path.join(dest, 'LICENSE'), readFileSync(path.join(LICENSE_DIR, text)));
    } else {
      writeFileSync(path.join(dest, 'LICENSE'), readFileSync(own));
    }
    writeFileSync(path.join(dest, 'THIRD-PARTY-LICENSES.txt'), thirdParty(entry, dir, nodeModules));
    copied.push({ ...entry, files: listFiles(src).length });
  }
  return copied;
}

/** Verifies `<dist>/vendor/` against node_modules: every file byte-identical, nothing extra but the license files. */
/** @param {VendorTarget} target @returns {string[]} */
export function checkVendor({ dist, root = FRONTEND, nodeModules = path.join(root, 'node_modules') }) {
  const problems = [];
  for (const entry of vendorPackages(root)) {
    const src = path.join(pkgDir(nodeModules, entry.pkg), entry.from);
    const dest = path.join(dist, 'vendor', entry.dir);
    if (!existsSync(dest)) {
      problems.push(`${entry.dir}: missing`);
      continue;
    }
    const want = listFiles(src);
    const have = listFiles(dest);
    for (const f of want) {
      if (!have.includes(f)) problems.push(`${entry.dir}/${f}: missing`);
      else if (sha256(path.join(src, f)) !== sha256(path.join(dest, f))) problems.push(`${entry.dir}/${f}: differs from node_modules`);
    }
    for (const f of have) if (!want.includes(f) && f !== 'LICENSE' && f !== 'THIRD-PARTY-LICENSES.txt') problems.push(`${entry.dir}/${f}: not in the package`);
    if (!have.includes('LICENSE')) problems.push(`${entry.dir}/LICENSE: missing`);
    if (!have.includes('THIRD-PARTY-LICENSES.txt')) problems.push(`${entry.dir}/THIRD-PARTY-LICENSES.txt: missing`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dist = process.env.GNOME_DIST_DIR?.trim() || path.join(FRONTEND, 'dist');
  if (process.argv.includes('--check')) {
    const problems = checkVendor({ dist });
    for (const p of problems) console.error(`copy-vendor --check: ${p}`);
    if (problems.length) process.exit(1);
    console.log(`copy-vendor --check: ${dist}/vendor matches node_modules`);
  } else {
    const copied = copyVendor({ dist });
    const problems = checkVendor({ dist });
    if (problems.length) {
      for (const p of problems) console.error(`copy-vendor: ${p}`);
      process.exit(1);
    }
    for (const c of copied) console.log(`vendor/${c.dir}/  ${c.pkg}@${c.version}  ${c.files} files  ${c.license}`);
  }
}
