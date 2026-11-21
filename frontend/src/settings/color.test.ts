import { describe, expect, it } from 'vitest';
import {
  ACCENT_MIN_CONTRAST,
  adjustLightness,
  contrastRatio,
  deriveAccent,
  ensureContrast,
  hexToOklch,
  isDark,
  mixOklab,
  oklchToHex,
  oklchToRgb,
  parseHex,
  rgbToOklab,
  toHex,
  withAlpha,
} from './color';
import { readFileSync } from 'node:fs';
import { ACCENT_PRESETS, DEFAULT_ACCENT_PRESET, DEFAULT_BG, TEXT_SURFACES, THEME_COLORS } from './apply';

/** Hex custom properties of the dark (:root) and light (:root.theme-light) palettes in tokens.css. */
function readTokens(): Record<'dark' | 'light', Record<string, string>> {
  const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
  const block = (selector: string): Record<string, string> => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('\n}', start));
    return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
  };
  const dark = block(':root');
  return { dark, light: { ...dark, ...block(':root.theme-light') } };
}

const TOKENS = readTokens();

type Tint = { rgb: string; alpha: number };

/** The translucent tints of each palette (tokens.css: --hover, --accent-soft, --moss-soft, …), as color + alpha. */
function readTints(): Record<'dark' | 'light', Record<string, Tint>> {
  const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
  const tints = (selector: string): Record<string, Tint> => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('\n}', start));
    const out: Record<string, Tint> = {};
    for (const m of body.matchAll(/(--[a-z0-9-]+):\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)) {
      out[m[1]!] = { rgb: `#${[m[2], m[3], m[4]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`, alpha: Number(m[5]) };
    }
    return out;
  };
  const dark = tints(':root');
  return { dark, light: { ...dark, ...tints(':root.theme-light') } };
}

const TINTS = readTints();

/** Source-over composite of a translucent color on an opaque one (sRGB, as browsers blend). */
function over(fg: { rgb: string; alpha: number }, bg: string): string {
  const a = parseHex(fg.rgb)!;
  const b = parseHex(bg)!;
  const mix = (x: number, y: number): number => x * fg.alpha + y * (1 - fg.alpha);
  return toHex({ r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) });
}

const close = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

describe('hex parsing', () => {
  it('parses 3/6-digit hex with or without #', () => {
    expect(parseHex('#fff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseHex('000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(toHex(parseHex(' #D6B47A ')!)).toBe('#d6b47a');
    for (const bad of ['', '#ff', '#fffff', 'red', '#ggg', 'rgb(0,0,0)']) expect(parseHex(bad)).toBeNull();
  });
});

describe('OKLab / OKLCH', () => {
  it('matches the reference values for white, black and sRGB red', () => {
    const white = rgbToOklab({ r: 1, g: 1, b: 1 });
    expect(close(white.L, 1, 1e-4) && close(white.a, 0, 1e-4) && close(white.b, 0, 1e-4)).toBe(true);
    expect(rgbToOklab({ r: 0, g: 0, b: 0 }).L).toBe(0);
    // Björn Ottosson's reference: sRGB red ≈ oklch(0.62796 0.25768 29.234)
    const red = hexToOklch('#ff0000')!;
    expect(close(red.l, 0.62796)).toBe(true);
    expect(close(red.c, 0.25768)).toBe(true);
    expect(close(red.h, 29.234, 0.05)).toBe(true);
  });

  it('round-trips sRGB colors', () => {
    for (const hex of ['#d6b47a', '#9aab6c', '#0f0f0d', '#f5f1e8', '#e0705b', '#8e97b0', '#123456', '#ffffff', '#000000']) {
      expect(oklchToHex(hexToOklch(hex)!)).toBe(hex);
    }
  });

  it('maps out-of-gamut colors into sRGB by reducing chroma (hue kept)', () => {
    const rgb = oklchToRgb({ l: 0.7, c: 0.4, h: 145 });
    for (const v of [rgb.r, rgb.g, rgb.b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const back = hexToOklch(toHex(rgb))!;
    expect(close(back.h, 145, 2)).toBe(true);
    expect(close(back.l, 0.7, 0.01)).toBe(true);
    expect(back.c).toBeLessThan(0.4);
  });

  it('greys have zero chroma and hue', () => {
    expect(hexToOklch('#808080')).toMatchObject({ c: 0, h: 0 });
  });
});

describe('WCAG contrast', () => {
  it('matches known ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', '#000000')).toBe(contrastRatio('#000000', '#ffffff'));
    expect(contrastRatio('nope', '#fff')).toBe(1);
  });

  it('the design tokens meet AA on every surface they are drawn on (tokens.css)', () => {
    for (const theme of ['dark', 'light'] as const) {
      const t = TOKENS[theme];
      const surfaces = ['--bg', '--bg-elevated', '--surface-1', '--surface-2'].map((n) => t[n]!);
      for (const text of ['--text', '--text-2', '--text-3', '--accent', '--accent-strong']) {
        for (const surface of surfaces) {
          expect(contrastRatio(t[text]!, surface), `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // Hovered / active rows of menus, listboxes and the palette: the --hover tint over --surface-2 (and the dense
      // glass variant over the page) carries secondary and tertiary text too.
      const hover = TINTS[theme]['--hover']!;
      const rowSurfaces = [over(hover, t['--surface-2']!), over(hover, over({ rgb: t['--surface-2']!, alpha: 0.92 }, t['--bg']!))];
      if (theme === 'dark') rowSurfaces.push(t['--surface-3']!);
      for (const text of ['--text', '--text-2', '--text-3', '--accent']) {
        for (const surface of rowSurfaces) {
          expect(contrastRatio(t[text]!, surface), `${theme} ${text} on hovered row ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // The selected item of monochrome chrome (rail, tab strip, settings navigation): primary and secondary text on
      // the --selected tint over every surface it is drawn on.
      const selected = TINTS[theme]['--selected']!;
      for (const base of surfaces) {
        for (const text of ['--text', '--text-2']) {
          expect(contrastRatio(t[text]!, over(selected, base)), `${theme} ${text} on --selected over ${base}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      // Tone text on its own soft tint (Tag, Badge, selected Chip, danger menu items), over the page and over
      // --surface-2 (menus, dialogs). Accent text on the accent tint uses --accent-strong.
      for (const [text, tint] of [
        ['--accent-strong', '--accent-soft'],
        ['--moss', '--moss-soft'],
        ['--slate', '--slate-soft'],
        ['--success', '--success-soft'],
        ['--warning', '--warning-soft'],
        ['--danger', '--danger-soft'],
      ] as const) {
        for (const base of [t['--bg']!, t['--surface-2']!]) {
          const surface = over(TINTS[theme][tint]!, base);
          expect(contrastRatio(t[text]!, surface), `${theme} ${text} on ${tint} over ${base}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrastRatio(t['--accent-ink']!, t['--accent']!), `${theme} ink`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t['--danger-ink']!, t['--danger']!), `${theme} danger ink`).toBeGreaterThanOrEqual(4.5);
      // Hierarchy: primary > secondary > tertiary.
      expect(contrastRatio(t['--text']!, t['--bg']!)).toBeGreaterThan(contrastRatio(t['--text-2']!, t['--bg']!));
      expect(contrastRatio(t['--text-2']!, t['--bg']!)).toBeGreaterThan(contrastRatio(t['--text-3']!, t['--bg']!));
      // Non-text UI (focus ring, state colors): ≥ 3:1 against the page.
      for (const ui of ['--focus', '--moss', '--slate', '--success', '--warning', '--danger']) {
        expect(contrastRatio(t[ui]!, t['--bg']!), `${theme} ${ui}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('the settings engine and tokens.css agree on the default palette', () => {
    expect(TOKENS.dark['--bg']).toBe(DEFAULT_BG.dark);
    expect(TOKENS.light['--bg']).toBe(DEFAULT_BG.light);
    for (const theme of ['dark', 'light'] as const) {
      expect(TOKENS[theme]['--bg-elevated']).toBe(TEXT_SURFACES[theme].elevated);
      expect(TOKENS[theme]['--surface-2']).toBe(TEXT_SURFACES[theme].surface2);
    }
    expect(TOKENS.dark['--accent']).toBe(ACCENT_PRESETS[DEFAULT_ACCENT_PRESET].dark);
    expect(TOKENS.light['--accent']).toBe(ACCENT_PRESETS[DEFAULT_ACCENT_PRESET].light);
    // Settings → Appearance → Custom colors shows the theme's own colors while no override is set.
    for (const theme of ['dark', 'light'] as const) {
      const t = TOKENS[theme];
      expect(THEME_COLORS[theme]).toMatchObject({ background: t['--bg'], surface: t['--surface-1'], text: t['--text'], mutedText: t['--text-2'] });
      const strong = TINTS[theme]['--hairline-strong']!;
      expect(THEME_COLORS[theme].border).toBe(over(strong, t['--bg']!));
    }
  });
});

describe('ensureContrast', () => {
  it('returns passing colors unchanged', () => {
    expect(ensureContrast('#D6B47A', '#0f0f0d', 4.5)).toBe('#d6b47a');
  });

  it('moves lightness just far enough, keeping hue', () => {
    const fixed = ensureContrast('#6b5a3a', '#0f0f0d', 4.5);
    expect(contrastRatio(fixed, '#0f0f0d')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(fixed, '#0f0f0d')).toBeLessThan(4.7);
    expect(close(hexToOklch(fixed)!.h, hexToOklch('#6b5a3a')!.h, 3)).toBe(true);
    const darker = ensureContrast('#e6c78f', '#f5f1e8', 4.5);
    expect(contrastRatio(darker, '#f5f1e8')).toBeGreaterThanOrEqual(4.5);
    expect(hexToOklch(darker)!.l).toBeLessThan(hexToOklch('#e6c78f')!.l);
  });
});

describe('deriveAccent', () => {
  const customs = ['#ff00ff', '#00ff00', '#0000ff', '#ffff00', '#333333', '#fafafa', '#7f7f7f', '#3a1f5d', '#00b3b3'];

  it('keeps every preset and custom accent legible on both themes', () => {
    const bases = [...Object.values(ACCENT_PRESETS).flatMap((p) => [p.dark, p.light ?? p.dark]), ...customs];
    for (const base of bases) {
      for (const theme of ['dark', 'light'] as const) {
        const bg = DEFAULT_BG[theme];
        const t = deriveAccent(base, theme, bg);
        expect(contrastRatio(t.accent, bg), `${base} ${theme}`).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
        expect(contrastRatio(t.ink, t.accent), `${base} ${theme} ink`).toBeGreaterThanOrEqual(4.5);
        expect(t.contrast).toBeCloseTo(contrastRatio(t.accent, bg), 6);
        expect(t.soft).toMatch(/^rgba\(\d+, \d+, \d+, 0\.1[24]\)$/);
        expect(t.focus).toBe(theme === 'dark' ? t.strong : t.accent);
      }
    }
  });

  it('only adjusts the accent when it is needed, and says so', () => {
    expect(deriveAccent('#d6b47a', 'dark', DEFAULT_BG.dark)).toMatchObject({ accent: '#d6b47a', adjusted: false });
    const adjusted = deriveAccent('#d6b47a', 'light', DEFAULT_BG.light);
    expect(adjusted.adjusted).toBe(true);
    expect(hexToOklch(adjusted.accent)!.l).toBeLessThan(hexToOklch('#d6b47a')!.l);
  });

  it('derives hover colors in the right direction', () => {
    const dark = deriveAccent('#9aab6c', 'dark', DEFAULT_BG.dark);
    expect(hexToOklch(dark.strong)!.l).toBeGreaterThan(hexToOklch(dark.accent)!.l);
    const light = deriveAccent('#5e6f34', 'light', DEFAULT_BG.light);
    expect(hexToOklch(light.strong)!.l).toBeLessThan(hexToOklch(light.accent)!.l);
  });

  it('falls back to wheat for invalid input', () => {
    expect(deriveAccent('banana', 'dark', DEFAULT_BG.dark).accent).toBe('#d6b47a');
  });
});

describe('helpers', () => {
  it('isDark / adjustLightness / withAlpha / mixOklab', () => {
    expect(isDark('#0f0f0d')).toBe(true);
    expect(isDark('#f5f1e8')).toBe(false);
    expect(hexToOklch(adjustLightness('#0f0f0d', 0.05))!.l).toBeGreaterThan(hexToOklch('#0f0f0d')!.l);
    expect(withAlpha('#d6b47a', 0.14)).toBe('rgba(214, 180, 122, 0.14)');
    expect(mixOklab('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixOklab('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixOklab('#d6b47a', '#d6b47a', 0.5)).toBe('#d6b47a');
  });
});
