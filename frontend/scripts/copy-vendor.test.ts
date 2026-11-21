import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VENDOR, VENDOR_PACKAGES, TRANSPORT_MODULES, SW_IMPORTS, ENGINE_HOST_SCRIPTS } from '../src/shared/proxy-origin';
import { FRONTEND, checkVendor, copyVendor, vendorPackages } from './copy-vendor.mjs';

const OUT = path.join(FRONTEND, 'node_modules', '.cache', 'gnome-copy-vendor-test');
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

describe('copy-vendor', () => {
  it('reads the same VENDOR_PACKAGES as the TypeScript contract', () => {
    expect(vendorPackages()).toEqual(VENDOR_PACKAGES);
  });

  it('frontend/package.json pins exactly the VENDOR_PACKAGES versions (aliases for the second transport family)', () => {
    const pkg = JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const v of VENDOR_PACKAGES) {
      const spec = all[v.pkg];
      expect(spec, v.pkg).toBeDefined();
      expect(spec?.replace(/^npm:.*@/, ''), v.pkg).toBe(v.version);
    }
    expect(all['epoxy-transport-bare']).toBe('npm:@mercuryworkshop/epoxy-transport@2.1.29');
    expect(all['libcurl-transport-bare']).toBe('npm:@mercuryworkshop/libcurl-transport@1.5.2');
    expect(all['fake-indexeddb']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('copies every file byte for byte with a LICENSE and the bundled components’ licenses', () => {
    const copied = copyVendor({ dist: OUT }) as Array<{ dir: string; files: number }>;
    expect(copied.map((c) => c.dir)).toEqual(VENDOR_PACKAGES.map((v) => v.dir));
    expect(checkVendor({ dist: OUT })).toEqual([]);
    const agpl = readFileSync(path.join(FRONTEND, 'scripts', 'licenses', 'AGPL-3.0.txt'), 'utf8');
    for (const v of VENDOR_PACKAGES) {
      const license = readFileSync(path.join(OUT, 'vendor', v.dir, 'LICENSE'), 'utf8');
      if (v.needsLicenseText) expect(license, v.dir).toBe(agpl);
      if (v.license.startsWith('AGPL')) expect(license, v.dir).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
    }
    expect(readFileSync(path.join(OUT, 'vendor', 'bare-mux', 'LICENSE'), 'utf8')).toMatch(/Permission is hereby granted/);
    const lc = readFileSync(path.join(OUT, 'vendor', 'libcurl-transport', 'THIRD-PARTY-LICENSES.txt'), 'utf8');
    expect(lc).toMatch(/libcurl\.js@\d+\.\d+\.\d+ {2}\(LGPL-3\.0-or-later\)/);
    expect(lc).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 3/);
    expect(readFileSync(path.join(OUT, 'vendor', 'epoxy-transport', 'THIRD-PARTY-LICENSES.txt'), 'utf8')).toMatch(/@mercuryworkshop\/epoxy-tls@/);
  });

  it('every path the engine host and the SW load exists in the copy', () => {
    const paths = [...Object.values(VENDOR), ...Object.values(TRANSPORT_MODULES.scramjet), ...Object.values(TRANSPORT_MODULES.ultraviolet)];
    paths.push(...ENGINE_HOST_SCRIPTS.filter((p) => p.startsWith('/vendor/')), ...SW_IMPORTS.filter((p) => p.startsWith('/vendor/')));
    for (const p of paths) expect(existsSync(path.join(OUT, p)), p).toBe(true);
  });

  it('the check finds a changed or extra file', () => {
    appendFileSync(path.join(OUT, 'vendor', 'bare-mux', 'index.js'), '\n// changed');
    appendFileSync(path.join(OUT, 'vendor', 'scramjet', 'extra.js'), 'x');
    const problems = checkVendor({ dist: OUT }) as string[];
    expect(problems).toContain('bare-mux/index.js: differs from node_modules');
    expect(problems).toContain('scramjet/extra.js: not in the package');
  });
});
