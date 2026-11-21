import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_GROUPS,
  GNOME_LICENSE,
  LICENSES,
  RUST_CRATES,
  allComponents,
  crateLicenseSummary,
  isLicenseExpression,
  isLicenseKey,
  licenseKeys,
  licenseLabel,
  licenseParts,
  type Component,
} from './licenses';

const ROOT = new URL('../../../../', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8');
const exists = (rel: string): boolean => existsSync(new URL(rel, ROOT));
const json = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;

function component(id: string): Component {
  const c = allComponents().find((x) => x.id === id);
  if (!c) throw new Error(`no component ${id}`);
  return c;
}

describe('license expressions', () => {
  it('extracts the license keys of an expression', () => {
    expect(licenseKeys('MIT')).toEqual(['MIT']);
    expect(licenseKeys('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0']);
    expect(licenseKeys('(MIT OR Apache-2.0) AND Unicode-3.0')).toEqual(['MIT', 'Apache-2.0', 'Unicode-3.0']);
    expect(licenseKeys('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT')).toEqual(['Apache-2.0', 'LLVM-exception', 'MIT']);
  });

  it('splits expressions into links and lowercase operators', () => {
    const parts = licenseParts('(MIT OR Apache-2.0) AND Unicode-3.0');
    expect(parts.map((p) => (p.kind === 'license' ? p.key : p.text))).toEqual([
      '(',
      'MIT',
      'or',
      'Apache-2.0',
      ')',
      'and',
      'Unicode-3.0',
    ]);
    const mit = parts[1];
    expect(mit?.kind === 'license' && mit.url).toBe(LICENSES.MIT.url);
    expect(licenseParts('Something-Else')).toEqual([{ kind: 'text', text: 'Something-Else' }]);
    expect(licenseLabel('MIT OR Apache-2.0')).toBe('MIT or Apache-2.0');
  });

  it('tells expressions from free text a server may report', () => {
    expect(isLicenseExpression('GPL-3.0-or-later OR CC-BY-SA-3.0')).toBe(true);
    expect(isLicenseExpression('(MIT OR Apache-2.0) AND Unicode-3.0')).toBe(true);
    expect(isLicenseExpression('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(isLicenseExpression('No explicit licence; the author permits combining and republishing it (see homepage)')).toBe(false);
    expect(isLicenseExpression('CC-BY-3.0 (Fanboy) / EasyList licence')).toBe(false);
    expect(isLicenseExpression('')).toBe(false);
  });

  it('uses only known license keys everywhere', () => {
    const unknown: string[] = [];
    const check = (where: string, expr: string): void => {
      for (const k of licenseKeys(expr)) if (!isLicenseKey(k)) unknown.push(`${where}: ${k}`);
    };
    for (const c of allComponents()) {
      check(c.id, c.license);
      for (const b of c.includes ?? []) check(`${c.id} > ${b.name}`, b.license);
    }
    for (const c of RUST_CRATES) check(`crate ${c.name}`, c.license);
    expect(unknown).toEqual([]);
  });

  it('links every license to an https text', () => {
    for (const [key, info] of Object.entries(LICENSES)) {
      expect(info.url, key).toMatch(/^https:\/\//);
      expect(info.name.length, key).toBeGreaterThan(2);
    }
  });
});

describe('component list', () => {
  it('has unique ids, https links and a sentence-case note', () => {
    const ids = allComponents().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of allComponents()) {
      expect(c.url, c.id).toMatch(/^https:\/\//);
      for (const b of c.includes ?? []) if (b.url) expect(b.url, `${c.id} > ${b.name}`).toMatch(/^https:\/\//);
      if (c.note) expect(c.note, c.id).toMatch(/^[A-Z].*\.$/);
      expect(c.copyright === undefined || c.copyright.startsWith('Copyright'), c.id).toBe(true);
    }
    expect(new Set(COMPONENT_GROUPS.map((g) => g.id)).size).toBe(COMPONENT_GROUPS.length);
  });

  it('states the licenses the project decided on', () => {
    for (const id of ['scramjet', 'scramjet-controller', 'libcurl-transport', 'epoxy-transport']) {
      expect(component(id).license).toBe('AGPL-3.0-only');
    }
    // UV: package.json says MIT, the shipped LICENSE is the AGPL text (docs/research/ultraviolet.md).
    expect(component('ultraviolet').license).toBe('AGPL-3.0');
    expect(component('ultraviolet').note).toMatch(/MIT/);
    expect(component('bare-mux').license).toBe('MIT');
    expect(component('ghostery-adblocker').license).toBe('MPL-2.0');
    expect(component('tldts').license).toBe('MIT');
    expect(component('lucide').license).toBe('ISC');
    expect(component('svelte').license).toBe('MIT');
    expect(component('holywisp').license).toBe('ISC');
    for (const c of allComponents().filter((x) => x.id.startsWith('font-'))) expect(c.license).toBe('OFL-1.1');
    expect(component('easylist').license).toMatch(/GPL-3\.0-or-later OR CC-BY-SA-3\.0/);
  });

  it('matches GNOME’s own license in Cargo.toml and package.json', () => {
    expect(read('Cargo.toml')).toMatch(new RegExp(`^license = "${GNOME_LICENSE}"$`, 'm'));
    expect(json('frontend/package.json').license).toBe(GNOME_LICENSE);
  });
});

describe('versions match what is installed and pinned', () => {
  it('frontend runtime packages', () => {
    const installed = (pkg: string): unknown => json(`frontend/node_modules/${pkg}/package.json`).version;
    expect(component('svelte').version).toBe(installed('svelte'));
    expect(component('lucide').version).toBe(installed('@lucide/svelte'));
    expect(component('font-fraunces').version).toBe(installed('@fontsource-variable/fraunces'));
    expect(component('font-geist').version).toBe(installed('@fontsource-variable/geist'));
    expect(component('font-geist').version).toBe(installed('@fontsource-variable/geist-mono'));
    expect(component('font-inter').version).toBe(installed('@fontsource-variable/inter'));
    expect(component('font-montserrat').version).toBe(installed('@fontsource-variable/montserrat'));
    expect(component('font-atkinson').version).toBe(installed('@fontsource-variable/atkinson-hyperlegible-next'));
    // The content blocker's packages (WAVE-B3 D18: exact pins, one copy each).
    expect(component('ghostery-adblocker').version).toBe(installed('@ghostery/adblocker'));
    expect(component('tldts').version).toBe(installed('tldts-experimental'));
    expect(component('tldts').version).toBe(installed('tldts-core'));
    const blocking = component('ghostery-adblocker').includes ?? [];
    for (const pkg of ['@ghostery/adblocker-content', '@ghostery/adblocker-extended-selectors', '@ghostery/url-parser']) {
      expect(blocking.some((b) => b.name === `${pkg} ${String(installed(pkg))}`), `${pkg} credited with its installed version`).toBe(true);
    }
    // Every runtime dependency of the app is credited.
    const deps = Object.keys((json('frontend/package.json').dependencies ?? {}) as Record<string, string>);
    const credited: Record<string, string> = {
      '@lucide/svelte': 'lucide',
      '@fontsource-variable/fraunces': 'font-fraunces',
      '@fontsource-variable/geist': 'font-geist',
      '@fontsource-variable/geist-mono': 'font-geist',
      '@fontsource-variable/inter': 'font-inter',
      '@fontsource-variable/montserrat': 'font-montserrat',
      '@fontsource-variable/atkinson-hyperlegible-next': 'font-atkinson',
      '@ghostery/adblocker': 'ghostery-adblocker',
      '@ghostery/adblocker-content': 'ghostery-adblocker',
      '@ghostery/adblocker-extended-selectors': 'ghostery-adblocker',
      'tldts-experimental': 'tldts',
      'tldts-core': 'tldts',
    };
    for (const d of deps) expect(credited[d], `runtime dependency ${d} is not in the license list`).toBeDefined();
  });

  it('engine and transport pins (frontend/package.json: the builds copied to /vendor/ and served)', () => {
    const fe = json('frontend/package.json') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const e2e = json('tests/e2e/package.json').dependencies as Record<string, string>;
    // The frontend pins the engines it vendors; proxy-transports only comes with the e2e harness's packages.
    const pins: Record<string, string> = { ...e2e, ...fe.dependencies, ...fe.devDependencies };
    for (const pkg of ['@mercuryworkshop/scramjet', '@mercuryworkshop/scramjet-controller', '@titaniumnetwork-dev/ultraviolet', '@mercuryworkshop/bare-mux']) {
      expect({ ...fe.dependencies, ...fe.devDependencies }[pkg], `${pkg} pinned in frontend/package.json`).toBeDefined();
    }
    expect(component('scramjet').version).toBe(pins['@mercuryworkshop/scramjet']);
    expect(component('scramjet-controller').version).toBe(pins['@mercuryworkshop/scramjet-controller']);
    expect(component('ultraviolet').version).toBe(pins['@titaniumnetwork-dev/ultraviolet']);
    expect(component('bare-mux').version).toBe(pins['@mercuryworkshop/bare-mux']);
    expect(component('proxy-transports').version).toBe(pins['@mercuryworkshop/proxy-transports']);
    const lc = component('libcurl-transport').version ?? '';
    expect(lc).toContain(pins['@mercuryworkshop/libcurl-transport']);
    expect(lc).toContain(pins['libcurl-transport-bare']?.replace(/^npm:.*@/, ''));
    const ep = component('epoxy-transport').version ?? '';
    expect(ep).toContain(pins['@mercuryworkshop/epoxy-transport']);
    expect(ep).toContain(pins['epoxy-transport-bare']?.replace(/^npm:.*@/, ''));
  });

  it.runIf(exists('tests/e2e/node_modules/@titaniumnetwork-dev/ultraviolet/LICENSE'))(
    'installed engine license files say what the list says',
    () => {
      const nm = 'tests/e2e/node_modules/';
      expect(read(`${nm}@titaniumnetwork-dev/ultraviolet/LICENSE`)).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
      expect(read(`${nm}@mercuryworkshop/bare-mux/LICENSE`)).toMatch(/Permission is hereby granted, free of charge/);
      expect(read(`${nm}@mercuryworkshop/libcurl-transport/LICENSE`)).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
      expect(read(`${nm}libcurl.js/LICENSE`)).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE/);
      for (const pkg of ['@mercuryworkshop/scramjet', '@mercuryworkshop/scramjet-controller', '@mercuryworkshop/epoxy-transport']) {
        expect(json(`${nm}${pkg}/package.json`).license, pkg).toBe('AGPL-3.0-only');
      }
    },
  );

  it('HolyWisp pin and musl notice (services/holywisp)', () => {
    const version = read('services/holywisp/VERSION');
    const commit = /^HOLYWISP_COMMIT=([0-9a-f]+)$/m.exec(version)?.[1] ?? '';
    expect(commit.startsWith(component('holywisp').version ?? '-')).toBe(true);
    expect(/^HOLYWISP_LICENSE=(.+)$/m.exec(version)?.[1]).toBe(component('holywisp').license);
    expect(exists(`services/holywisp/licenses/musl-${component('musl').version}.COPYRIGHT`)).toBe(true);
  });

  it('IANA list version matches lib/tlds.ts', () => {
    expect(read('frontend/src/lib/tlds.ts')).toContain(`Version ${component('iana-tlds').version}`);
  });
});

describe('Rust crates', () => {
  it('are sorted, unique and locked at the listed version in Cargo.lock', () => {
    const keys = RUST_CRATES.map((c) => `${c.name}@${c.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    const names = RUST_CRATES.map((c) => c.name);
    expect([...names].sort()).toEqual(names);
    const locked = new Set(
      [...read('Cargo.lock').matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)].map((m) => `${m[1]}@${m[2]}`),
    );
    const missing = keys.filter((k) => !locked.has(k));
    expect(missing, 'crates or versions no longer in Cargo.lock: run node scripts/rust-crates.mjs').toEqual([]);
    expect(names.some((n) => n.startsWith('gnome-'))).toBe(false);
  });

  it('match the dependency graph of gnome-server (cargo tree), when cargo is available', (ctx) => {
    const run = spawnSync(process.execPath, ['scripts/rust-crates.mjs', '--check', '--offline'], {
      cwd: new URL('frontend/', ROOT),
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (run.status === 2 || run.error) {
      // No cargo here (e.g. a frontend-only build image) or a Cargo.lock mid-update: nothing to compare with.
      console.warn(`[licenses.test] skipped the cargo tree comparison: ${(run.stderr || String(run.error)).trim()}`);
      ctx.skip();
    }
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it('summarizes licenses without losing a crate', () => {
    const summary = crateLicenseSummary();
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(RUST_CRATES.length);
    // "Apache-2.0 OR MIT" and "MIT OR Apache-2.0" are one choice.
    expect(summary.filter((s) => licenseKeys(s.license).join() === 'MIT,Apache-2.0')).toHaveLength(1);
    expect(summary.filter((s) => licenseKeys(s.license).join() === 'Apache-2.0,MIT')).toHaveLength(0);
    expect(summary[0]?.license).toBe('MIT OR Apache-2.0');
    for (let i = 1; i < summary.length; i++) expect(summary[i - 1]!.count).toBeGreaterThanOrEqual(summary[i]!.count);
  });
});
