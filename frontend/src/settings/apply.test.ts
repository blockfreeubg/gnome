import { describe, expect, it, vi } from 'vitest';
import {
  ACCENT_PRESETS,
  accentTokens,
  applyAppearance,
  DEFAULT_ACCENT_PRESET,
  DEFAULT_BG,
  computeAppearance,
  getMotionScale,
  MANAGED_CLASSES,
  motionAllowsMovement,
  onMotionChange,
  resolveAppearance,
  resolveMotion,
  resolveTheme,
  textSurfaces,
  type Environment,
} from './apply';
import { contrastRatio } from './color';
import { createDefaultSettings } from './defaults';
import type { Settings } from './schema';

const ENV: Environment = { prefersLight: false, prefersReducedMotion: false };

function withAppearance(patch: Partial<Settings['appearance']>, perf: Partial<Settings['performance']> = {}): Settings {
  const s = createDefaultSettings();
  return { ...s, appearance: { ...s.appearance, ...patch }, performance: { ...s.performance, ...perf } };
}

/** Minimal stand-in for <html> (style + classList) used by applyAppearance. */
function fakeRoot(): HTMLElement & { vars: Map<string, string> } {
  const vars = new Map<string, string>();
  const classes = new Set<string>();
  const style = {
    colorScheme: '',
    setProperty: (k: string, v: string) => void vars.set(k, v),
    removeProperty: (k: string) => {
      vars.delete(k);
      return '';
    },
    [Symbol.iterator]: function* () {
      yield* vars.keys();
    },
  };
  const classList = {
    toggle: (c: string, on?: boolean) => {
      if (on ?? !classes.has(c)) classes.add(c);
      else classes.delete(c);
      return classes.has(c);
    },
    contains: (c: string) => classes.has(c),
  };
  return { style, classList, vars } as unknown as HTMLElement & { vars: Map<string, string> };
}

describe('theme and motion resolution', () => {
  it('follows the OS only for "system" / "normal"', () => {
    expect(resolveTheme('system', { prefersLight: true })).toBe('light');
    expect(resolveTheme('system', { prefersLight: false })).toBe('dark');
    expect(resolveTheme('dark', { prefersLight: true })).toBe('dark');
    expect(resolveMotion('normal', { prefersReducedMotion: true })).toBe('reduced');
    expect(resolveMotion('expressive', { prefersReducedMotion: true })).toBe('expressive');
    expect(resolveMotion('none', { prefersReducedMotion: false })).toBe('none');
  });
});

describe('computeAppearance', () => {
  it('maps every appearance setting to variables', () => {
    const p = computeAppearance(
      withAppearance({ fontSize: 16, fontFamily: 'atkinson', density: 'compact', radius: 10, transparency: 0.9, blur: 24 }),
    );
    expect(p.vars).toMatchObject({
      '--font-size': '16px',
      '--density': '0.85',
      '--radius': '10px',
      '--glass-opacity': '0.9',
      '--blur': '24px',
    });
    expect(p.vars['--font-ui']).toContain('Atkinson Hyperlegible Next Variable');
    expect(computeAppearance(withAppearance({ density: 'spacious' })).vars['--density']).toBe('1.15');
  });

  it('keeps the hand-tuned mint tokens by default and derives everything else', () => {
    expect(createDefaultSettings().appearance.accentPreset).toBe(DEFAULT_ACCENT_PRESET);
    expect(computeAppearance(createDefaultSettings()).dark).toEqual({});
    expect(computeAppearance(createDefaultSettings()).light).toEqual({});
    const moss = computeAppearance(withAppearance({ accentPreset: 'moss' }));
    expect(moss.dark['--accent']).toBe(ACCENT_PRESETS.moss.dark);
    // Every preset other than the default is derived (and legible: see color.test.ts).
    for (const id of Object.keys(ACCENT_PRESETS) as Array<keyof typeof ACCENT_PRESETS>) {
      if (id === DEFAULT_ACCENT_PRESET) continue;
      expect(computeAppearance(withAppearance({ accentPreset: id })).dark['--accent'], id).toBeDefined();
    }
    expect(Object.keys(moss.light).sort()).toEqual(['--accent', '--accent-ink', '--accent-soft', '--accent-strong', '--focus']);
  });

  it('derives a legible custom accent on every text surface', () => {
    for (const accent of ['#ffee00', '#202020', '#ff00aa', '#4060ff']) {
      const a = withAppearance({ accentPreset: 'custom', accent }).appearance;
      const t = accentTokens(a);
      for (const theme of ['dark', 'light'] as const) {
        for (const surface of textSurfaces(a.colors, theme)) {
          expect(contrastRatio(t[theme].accent, surface), `${accent} ${theme} ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('applies custom colors and derives dependent surfaces', () => {
    const p = computeAppearance(
      withAppearance({ colors: { background: '#102030', surface: '#203040', text: '#f0f0f0', mutedText: '#a0a8b0', border: '#405060' } }),
    );
    expect(p.vars['--bg']).toBe('#102030');
    expect(p.vars['--bg-elevated']).not.toBe('#102030');
    expect(p.vars['--surface-1']).toBe('#203040');
    expect(p.vars['--surface-3']).toBeDefined();
    expect(p.vars['--text']).toBe('#f0f0f0');
    expect(p.vars['--text-2']).toBe('#a0a8b0');
    expect(contrastRatio(p.vars['--text-3']!, '#102030')).toBeGreaterThanOrEqual(4.5);
    expect(p.vars['--hairline']).toBe('rgba(64, 80, 96, 0.55)');
    expect(p.vars['--hairline-strong']).toBe('#405060');
    expect(p.meta).toEqual({ dark: '#102030', light: '#102030' });
    expect(p.dark['--accent']).toBeDefined(); // custom background → accent re-derived against it
  });

  it('switches to opaque/flat surfaces for reduce transparency, blur 0 and GPU effects off', () => {
    expect(computeAppearance(withAppearance({ reduceTransparency: true })).classes).toEqual(['reduce-transparency']);
    expect(computeAppearance(withAppearance({ blur: 0 })).classes).toEqual(['reduce-transparency']);
    expect(computeAppearance(withAppearance({}, { gpuEffects: false })).classes).toEqual(['no-gpu-effects']);
    expect(computeAppearance(createDefaultSettings()).classes).toEqual([]);
  });
});

describe('resolveAppearance', () => {
  it('picks the palette, motion scale and classes for the environment', () => {
    const p = computeAppearance(withAppearance({ theme: 'system', accentPreset: 'ember', animation: 'normal' }));
    const dark = resolveAppearance(p, ENV);
    expect(dark).toMatchObject({ theme: 'dark', motion: 'normal', scale: 1, metaColor: DEFAULT_BG.dark });
    expect(dark.vars['--accent']).toBe(p.dark['--accent']);
    expect(dark.vars['--motion']).toBe('1');
    expect(dark.vars['--motion-move']).toBe('1');
    expect(dark.classes).toEqual(['theme-dark']);

    const light = resolveAppearance(p, { prefersLight: true, prefersReducedMotion: true });
    expect(light).toMatchObject({ theme: 'light', motion: 'reduced', scale: 0.5, metaColor: DEFAULT_BG.light });
    expect(light.vars['--accent']).toBe(p.light['--accent']);
    expect(light.vars['--motion-move']).toBe('0');
    expect(light.classes).toEqual(['theme-light', 'motion-reduced']);

    const none = resolveAppearance(computeAppearance(withAppearance({ animation: 'none' })), ENV);
    expect(none).toMatchObject({ scale: 0 });
    expect(none.classes).toContain('motion-none');
    expect(resolveAppearance(computeAppearance(withAppearance({ animation: 'expressive' })), ENV).scale).toBe(1.25);
  });
});

describe('applyAppearance', () => {
  it('writes variables and managed classes, and removes stale variables', () => {
    const root = fakeRoot();
    root.style.setProperty('--accent', '#123456'); // e.g. left by the boot script
    root.style.setProperty('--unrelated-but-ours', 'x');
    applyAppearance(computeAppearance(withAppearance({ theme: 'light', reduceTransparency: true })), ENV, root);
    expect(root.vars.get('--font-size')).toBe('14px');
    expect(root.vars.has('--accent')).toBe(false); // default mint → tokens.css
    expect(root.vars.has('--unrelated-but-ours')).toBe(false);
    expect(root.classList.contains('theme-light')).toBe(true);
    expect(root.classList.contains('theme-dark')).toBe(false);
    expect(root.classList.contains('reduce-transparency')).toBe(true);
    expect(root.style.colorScheme).toBe('light');

    applyAppearance(computeAppearance(withAppearance({ theme: 'dark', accentPreset: 'fern' })), ENV, root);
    expect(root.vars.get('--accent')).toBeDefined();
    expect(root.classList.contains('reduce-transparency')).toBe(false);
    for (const c of MANAGED_CLASSES) expect(['theme-dark'].includes(c)).toBe(root.classList.contains(c));
  });

  it('updates the JS motion multiplier and notifies listeners only on change', () => {
    const root = fakeRoot();
    const fn = vi.fn();
    const off = onMotionChange(fn);
    applyAppearance(computeAppearance(withAppearance({ animation: 'reduced' })), ENV, root);
    expect(getMotionScale()).toBe(0.5);
    expect(motionAllowsMovement()).toBe(false);
    applyAppearance(computeAppearance(withAppearance({ animation: 'reduced', radius: 3 })), ENV, root);
    applyAppearance(computeAppearance(withAppearance({ animation: 'normal' })), ENV, root);
    off();
    expect(getMotionScale()).toBe(1);
    expect(motionAllowsMovement()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
