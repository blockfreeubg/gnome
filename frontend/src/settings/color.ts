/**
 * Color math for the settings engine: sRGB ⇄ OKLab/OKLCH (Björn Ottosson), gamut mapping by chroma reduction,
 * WCAG 2.x relative luminance / contrast, and accent derivation so any custom accent stays legible.
 */

export interface Rgb {
  /** Gamma-encoded sRGB channels in 0…1. */
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number; // 0…1
  c: number; // ≥ 0 (sRGB colors stay below ~0.33)
  h: number; // degrees 0…360
}

export function parseHex(input: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m || !m[1]) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (ch) => ch + ch);
  const n = Number.parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function toHex(rgb: Rgb): string {
  const ch = (v: number): string =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function rgbToOklab(rgb: Rgb): { L: number; a: number; b: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Unclamped linear-light conversion (channels may fall outside 0…1 for out-of-gamut colors). */
function oklabToLinear(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const { L, a, b } = rgbToOklab(rgb);
  const c = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: c < 1e-6 ? 0 : c, h: c < 1e-6 ? 0 : h };
}

function inGamut(lin: Rgb, eps = 1e-5): boolean {
  return [lin.r, lin.g, lin.b].every((v) => v >= -eps && v <= 1 + eps);
}

/** OKLCH → sRGB, mapping out-of-gamut colors into sRGB by reducing chroma (hue and lightness preserved). */
export function oklchToRgb(color: Oklch): Rgb {
  const l = clamp01(color.l);
  const hr = (color.h * Math.PI) / 180;
  const at = (c: number): Rgb => oklabToLinear(l, c * Math.cos(hr), c * Math.sin(hr));
  let lin = at(color.c);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return { r: linearToSrgb(clamp01(lin.r)), g: linearToSrgb(clamp01(lin.g)), b: linearToSrgb(clamp01(lin.b)) };
}

export const hexToOklch = (hex: string): Oklch | null => {
  const rgb = parseHex(hex);
  return rgb ? rgbToOklch(rgb) : null;
};

export const oklchToHex = (c: Oklch): string => toHex(oklchToRgb(c));

/** WCAG 2.x relative luminance. */
export function luminance(rgb: Rgb): number {
  return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
}

/** WCAG 2.x contrast ratio between two hex colors (1…21). Invalid input yields 1. */
export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  const la = luminance(ra);
  const lb = luminance(rb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function isDark(hex: string): boolean {
  const c = hexToOklch(hex);
  return c ? c.l < 0.6 : true;
}

/** Shifts OKLCH lightness by `delta` (clamped), optionally scaling chroma. */
export function adjustLightness(hex: string, delta: number, chromaScale = 1): string {
  const c = hexToOklch(hex);
  if (!c) return hex;
  return oklchToHex({ l: clamp01(c.l + delta), c: c.c * chromaScale, h: c.h });
}

/**
 * Moves `fg` lightness (keeping hue/chroma) until it reaches `min` contrast against `bg`. Direction defaults to
 * away from the background. Returns the closest passing color (or the extreme if none passes).
 */
export function ensureContrast(fg: string, bg: string, min: number, direction?: 'lighter' | 'darker'): string {
  if (contrastRatio(fg, bg) >= min) return fg.toLowerCase();
  const c = hexToOklch(fg);
  if (!c) return fg;
  const dir = direction ?? (isDark(bg) ? 'lighter' : 'darker');
  let lo = c.l;
  let hi = dir === 'lighter' ? 1 : 0;
  const extreme = oklchToHex({ ...c, l: hi });
  if (contrastRatio(extreme, bg) < min) return extreme;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(oklchToHex({ ...c, l: mid }), bg) >= min) hi = mid;
    else lo = mid;
  }
  return oklchToHex({ ...c, l: hi });
}

export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const to255 = (v: number): number => Math.round(clamp01(v) * 255);
  return `rgba(${to255(rgb.r)}, ${to255(rgb.g)}, ${to255(rgb.b)}, ${Number(alpha.toFixed(3))})`;
}

/** Mixes two hex colors in OKLab (t = 0 → a, 1 → b). */
export function mixOklab(a: string, b: string, t: number): string {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return a;
  const la = rgbToOklab(ra);
  const lb = rgbToOklab(rb);
  const L = la.L + (lb.L - la.L) * t;
  const A = la.a + (lb.a - la.a) * t;
  const B = la.b + (lb.b - la.b) * t;
  const lin = oklabToLinear(L, A, B);
  return toHex({ r: linearToSrgb(clamp01(lin.r)), g: linearToSrgb(clamp01(lin.g)), b: linearToSrgb(clamp01(lin.b)) });
}

// ── Accent derivation ────────────────────────────────────────────────────────────────────────────────────────────

export interface AccentTokens {
  accent: string;
  strong: string;
  soft: string;
  ink: string;
  focus: string;
  /** True when the requested accent had to be adjusted to stay legible on the background. */
  adjusted: boolean;
  /** Lowest contrast of the final accent against the given backgrounds (used as text: links, active navigation). */
  contrast: number;
}

/** Minimum contrast for accent-colored text against the page background (WCAG AA, normal text). */
export const ACCENT_MIN_CONTRAST = 4.5;

/**
 * Derives accent tokens for a theme. The accent keeps its hue; lightness moves only as far as needed for
 * ≥ 4.5:1 against every background in `bg` (the page, the rail and menus — accent text appears on all of them).
 * `strong` is the hover variant (lighter on dark, darker on light), `ink` the text color on accent fills (≥ 4.5:1),
 * `soft` a translucent tint for selection and halos.
 */
export function deriveAccent(base: string, theme: 'dark' | 'light', bg: string | readonly string[]): AccentTokens {
  const backgrounds = typeof bg === 'string' ? [bg] : bg;
  const requested = (parseHex(base) ? base : '#d6b47a').toLowerCase();
  const normalized = toHex(parseHex(requested) as Rgb);
  const dir = theme === 'dark' ? 'lighter' : 'darker';
  // Moving lightness away from same-side backgrounds only raises contrast, so passing them one by one passes all.
  let accent = normalized;
  for (const b of backgrounds) accent = ensureContrast(accent, b, ACCENT_MIN_CONTRAST, dir);
  const adjusted = accent !== normalized;
  const lch = hexToOklch(accent) as Oklch;
  const strong =
    theme === 'dark'
      ? oklchToHex({ l: Math.min(0.97, lch.l + 0.055), c: lch.c * 0.95, h: lch.h })
      : oklchToHex({ l: Math.max(0.2, lch.l - 0.07), c: lch.c, h: lch.h });
  const darkInk = oklchToHex({ l: 0.2, c: Math.min(lch.c * 0.35, 0.03), h: lch.h });
  const lightInk = oklchToHex({ l: 0.985, c: Math.min(lch.c * 0.2, 0.015), h: lch.h });
  const preferred = theme === 'dark' ? darkInk : lightInk;
  const other = theme === 'dark' ? lightInk : darkInk;
  let ink = contrastRatio(preferred, accent) >= 4.5 ? preferred : other;
  if (contrastRatio(ink, accent) < 4.5) {
    ink = contrastRatio('#000000', accent) > contrastRatio('#ffffff', accent) ? '#000000' : '#ffffff';
  }
  return {
    accent,
    strong,
    soft: withAlpha(accent, theme === 'dark' ? 0.14 : 0.12),
    ink,
    focus: theme === 'dark' ? strong : accent,
    adjusted,
    contrast: Math.min(...backgrounds.map((b) => contrastRatio(accent, b))),
  };
}
