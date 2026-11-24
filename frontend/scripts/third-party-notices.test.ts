import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describe as describePkgs, licenseAllowed, packageDir, packagesFromGraphs, render } from './third-party-notices.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function root(withLicense: boolean): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gnome-notices-'));
  dirs.push(d);
  const pkg = path.join(d, 'node_modules/@s/lib');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@s/lib', version: '1.2.3', license: 'MIT', repository: 'git+https://example.org/s/lib.git' }));
  if (withLicense) fs.writeFileSync(path.join(pkg, 'LICENSE'), 'MIT License\n\nCopyright (c) s\n');
  fs.writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@s/lib': { resolved: 'https://registry.npmjs.org/@s/lib/-/lib-1.2.3.tgz' } } }));
  const dist = path.join(d, 'dist/.vite');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'gnome-chunks.json'), JSON.stringify({ 'assets/a.js': { modules: ['src/main.ts', 'node_modules/@s/lib/dist/index.js', '\0virtual'] } }));
  return d;
}

describe('third-party notices', () => {
  it('finds packages from a chunk-graph fixture', () => {
    expect(packageDir('node_modules/a/node_modules/@s/b/x.js')).toBe('node_modules/a/node_modules/@s/b');
    expect(packageDir('src/main.ts')).toBeNull();
    const d = root(true);
    const { dirs: found, missing } = packagesFromGraphs(path.join(d, 'dist'));
    expect(found).toEqual(['node_modules/@s/lib']);
    expect(missing).toContain('.vite/gnome-sw-chunks.json');
    const pkgs = describePkgs(found, { root: d });
    expect(pkgs[0]).toMatchObject({ name: '@s/lib', version: '1.2.3', license: 'MIT', repository: 'https://example.org/s/lib.git' });
    const txt = render(pkgs);
    expect(txt).toContain('Tarball: https://registry.npmjs.org/@s/lib/-/lib-1.2.3.tgz');
    expect(txt).toContain('Copyright (c) s');
  });

  it('fails on a package without a license file or with a license outside the allow-list', () => {
    const d = root(false);
    expect(() => describePkgs(['node_modules/@s/lib'], { root: d })).toThrow(/no license file/);
    expect(licenseAllowed('MIT OR GPL-3.0', ['MIT'])).toBe(true);
    expect(licenseAllowed('MIT AND GPL-3.0', ['MIT'])).toBe(false);
    expect(licenseAllowed(undefined, ['MIT'])).toBe(false);
  });
});
