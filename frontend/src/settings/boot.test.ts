/**
 * The inline pre-paint script in index.html must apply exactly what the settings engine would (resolveAppearance),
 * from the localStorage mirror, before the bundle loads. This runs the real script from index.html in a sandbox.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { computeAppearance, DEFAULT_BG, resolveAppearance, type Environment } from './apply';
import { createDefaultSettings } from './defaults';
import type { Settings } from './schema';
import { STORAGE_KEY } from './store.svelte';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const BOOT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '').find((s) => s.includes(STORAGE_KEY));

interface BootResult {
  vars: Record<string, string>;
  classes: string[];
  colorScheme: string;
  meta: string;
}

function runBoot(stored: string | null, env: Environment, opts: { throwOnStorage?: boolean } = {}): BootResult {
  if (!BOOT) throw new Error('boot script not found in index.html');
  const vars: Record<string, string> = {};
  const classes = new Set(['theme-dark']); // as served in <html class="theme-dark">
  const meta = { content: '#0a0a0a', setAttribute(_: string, v: string) { this.content = v; } };
  const documentElement = {
    style: { colorScheme: '', setProperty: (k: string, v: string) => void (vars[k] = v) },
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
    },
  };
  const window = {
    localStorage: {
      getItem: (k: string) => {
        if (opts.throwOnStorage) throw new Error('SecurityError');
        return k === STORAGE_KEY ? stored : null;
      },
    },
    matchMedia: (q: string) => ({
      matches: q.includes('prefers-color-scheme: light') ? env.prefersLight : q.includes('prefers-reduced-motion') ? env.prefersReducedMotion : false,
    }),
  };
  const document = { documentElement, querySelector: (s: string) => (s === 'meta[name="theme-color"]' ? meta : null) };
  runInNewContext(BOOT, { window, document });
  return { vars, classes: [...classes].sort(), colorScheme: documentElement.style.colorScheme, meta: meta.content };
}

function mirrorFor(settings: Settings): string {
  return JSON.stringify({ v: 1, updatedAt: 1, settings, boot: computeAppearance(settings) });
}

function variant(patch: (s: Settings) => void): Settings {
  const s = createDefaultSettings();
  patch(s);
  return s;
}

const VARIANTS: Array<[string, Settings]> = [
  ['defaults', createDefaultSettings()],
  ['light', variant((s) => (s.appearance.theme = 'light'))],
  ['system', variant((s) => (s.appearance.theme = 'system'))],
  ['moss accent', variant((s) => (s.appearance.accentPreset = 'moss'))],
  ['custom accent', variant((s) => Object.assign(s.appearance, { accentPreset: 'custom', accent: '#3366ff' }))],
  ['custom colors', variant((s) => (s.appearance.colors = { background: '#101418', surface: '#182028', text: '#eeeeee', mutedText: '#99aabb', border: '#334455' }))],
  ['typography + density', variant((s) => Object.assign(s.appearance, { fontFamily: 'inter', fontSize: 17, density: 'spacious', radius: 2 }))],
  ['glass off', variant((s) => Object.assign(s.appearance, { reduceTransparency: true, blur: 0, transparency: 1 }))],
  ['gpu effects off', variant((s) => (s.performance.gpuEffects = false))],
  ['motion none', variant((s) => (s.appearance.animation = 'none'))],
  ['motion reduced', variant((s) => (s.appearance.animation = 'reduced'))],
  ['motion expressive', variant((s) => (s.appearance.animation = 'expressive'))],
];

const ENVS: Environment[] = [
  { prefersLight: false, prefersReducedMotion: false },
  { prefersLight: true, prefersReducedMotion: false },
  { prefersLight: false, prefersReducedMotion: true },
  { prefersLight: true, prefersReducedMotion: true },
];

describe('pre-paint boot script (index.html)', () => {
  it('exists and reads the settings mirror key', () => {
    expect(BOOT).toBeDefined();
  });

  for (const [name, settings] of VARIANTS) {
    it(`matches resolveAppearance: ${name}`, () => {
      for (const env of ENVS) {
        const expected = resolveAppearance(computeAppearance(settings), env);
        const got = runBoot(mirrorFor(settings), env);
        expect(got.vars, `${name} ${JSON.stringify(env)}`).toEqual(expected.vars);
        expect(got.classes).toEqual([...expected.classes].sort());
        expect(got.colorScheme).toBe(expected.theme);
        expect(got.meta).toBe(expected.metaColor);
      }
    });
  }

  it('falls back to the dark defaults without a mirror, with a broken mirror, or without storage', () => {
    for (const stored of [null, '{broken', '"a string"', '{"boot":42}']) {
      const got = runBoot(stored, { prefersLight: false, prefersReducedMotion: false });
      expect(got.classes).toEqual(['theme-dark']);
      expect(got.vars).toEqual({ '--motion': '1', '--motion-move': '1' });
      expect(got.colorScheme).toBe('dark');
    }
    const blocked = runBoot(null, { prefersLight: false, prefersReducedMotion: true }, { throwOnStorage: true });
    expect(blocked.classes).toEqual(['motion-reduced', 'theme-dark']);
    expect(blocked.vars['--motion']).toBe('0.5');
  });

  it('survives a damaged boot payload: wrong types never leave the page half-styled', () => {
    const env = { prefersLight: false, prefersReducedMotion: false };
    const damaged = [
      { theme: 'light', vars: 'oops', light: [1, 2], classes: 'abc def', meta: 'x' },
      { theme: 'light', classes: ['reduce-transparency', 'two words', '<b>', 7, 'no-gpu-effects'], meta: { light: 'red; x' } },
      { theme: 'light', vars: ['--a'], dark: null, light: 5, classes: null, meta: null },
    ];
    for (const boot of damaged) {
      const got = runBoot(JSON.stringify({ boot }), env);
      expect(got.classes.filter((c) => c.startsWith('theme-'))).toEqual(['theme-light']);
      expect(got.classes.every((c) => /^[a-z][a-z0-9-]*$/.test(c))).toBe(true);
      expect(got.colorScheme).toBe('light');
      expect(got.meta).toBe(DEFAULT_BG.light);
      expect(Object.keys(got.vars).every((k) => k.startsWith('--'))).toBe(true);
    }
    expect(runBoot(JSON.stringify({ boot: damaged[1] }), env).classes).toEqual(['no-gpu-effects', 'reduce-transparency', 'theme-light']);
  });

  it('ignores injected non-variable keys in a tampered mirror', () => {
    const tampered = JSON.stringify({ boot: { theme: 'light', vars: { color: 'red', '--x': '1' }, dark: {}, light: {}, classes: [] } });
    const got = runBoot(tampered, { prefersLight: false, prefersReducedMotion: false });
    expect(got.vars.color).toBeUndefined();
    expect(got.vars['--x']).toBe('1');
    expect(got.classes).toEqual(['theme-light']);
  });
});
