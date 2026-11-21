/**
 * Settings → CSS. `computeAppearance` is pure (unit-tested) and produces the "boot payload" that is also mirrored
 * to localStorage, so the inline pre-paint script in index.html can apply exactly the same variables before the
 * app bundle loads (no flash of the wrong theme/accent). `applyAppearance` writes it to <html>.
 *
 * Keep the inline boot script in index.html in sync with `applyAppearance` (a test executes both and compares).
 */
import { fontStack } from '../styles/fonts';
import { adjustLightness, contrastRatio, deriveAccent, ensureContrast, isDark, mixOklab, withAlpha, type AccentTokens } from './color';
import type { AccentPreset, Motion, Settings, Theme } from './schema';

export const DEFAULT_BG = { dark: '#0a0a0a', light: '#f4f4f4' } as const;

/**
 * Default surfaces that accent-colored text is drawn on (page, rail/toolbar, menus) per theme (tokens.css). Derived
 * accents must reach 4.5:1 on all of them, not just on the page background.
 */
export const TEXT_SURFACES = {
  dark: { bg: '#0a0a0a', elevated: '#0e0e0e', surface2: '#191919' },
  light: { bg: '#f4f4f4', elevated: '#fafafa', surface2: '#ffffff' },
} as const;

/**
 * The theme's own colors for Settings → Appearance → Custom colors (what each slot shows while no override is set):
 * tokens.css --bg, --surface-1, --text, --text-2 and --hairline-strong composited over --bg.
 */
export const THEME_COLORS = {
  dark: { background: '#0a0a0a', surface: '#131313', text: '#f5f5f5', mutedText: '#ababab', border: '#2c2c2c' },
  light: { background: '#f4f4f4', surface: '#fbfbfb', text: '#111111', mutedText: '#4d4d4d', border: '#d2d2d2' },
} as const;

export interface AccentPresetDef {
  label: string;
  /** Value tuned for the dark theme (DESIGN.md §3). */
  dark: string;
  /** Explicit light-theme value from DESIGN.md, or null to derive one with ≥ 4.5:1 contrast. */
  light: string | null;
}

/** The accent every default surface is tuned for (tokens.css --accent): no derived variables are needed for it. */
export const DEFAULT_ACCENT_PRESET = 'mint' satisfies Exclude<AccentPreset, 'custom'>;

/** In the order the accent picker shows them (DESIGN.md §3: mint and periwinkle first, the earth tones re-tuned). */
export const ACCENT_PRESETS: Readonly<Record<Exclude<AccentPreset, 'custom'>, AccentPresetDef>> = {
  mint: { label: 'Mint', dark: '#9ff0c8', light: '#0b7a4e' },
  periwinkle: { label: 'Periwinkle', dark: '#9fb5f6', light: '#3555c4' },
  wheat: { label: 'Wheat', dark: '#e3c58d', light: '#7d5f22' },
  moss: { label: 'Moss', dark: '#b7cb8c', light: '#4f6324' },
  lichen: { label: 'Lichen', dark: '#d0da9f', light: null },
  ember: { label: 'Ember', dark: '#f2a272', light: null },
  slate: { label: 'Slate', dark: '#aab4d1', light: '#4d5876' },
  mushroom: { label: 'Mushroom', dark: '#dcbbb4', light: null },
  fern: { label: 'Fern', dark: '#86caa7', light: null },
};

const DENSITY: Readonly<Record<Settings['appearance']['density'], number>> = {
  compact: 0.85,
  comfortable: 1,
  spacious: 1.15,
};

export const MOTION_SCALE: Readonly<Record<Motion, number>> = { none: 0, reduced: 0.5, normal: 1, expressive: 1.25 };

/** Classes on <html> managed by the settings engine (everything else on <html> is left alone). */
export const MANAGED_CLASSES = [
  'theme-dark',
  'theme-light',
  'reduce-transparency',
  'no-gpu-effects',
  'motion-none',
  'motion-reduced',
] as const;

export interface BootPayload {
  theme: Theme;
  motion: Motion;
  /** Theme-independent variables. */
  vars: Record<string, string>;
  /** Variables for the dark / light palette (accent derivatives). */
  dark: Record<string, string>;
  light: Record<string, string>;
  /** Static classes (motion/theme classes are resolved at apply time from media queries). */
  classes: string[];
  /** <meta name="theme-color"> per theme. */
  meta: { dark: string; light: string };
}

export interface AccentReport {
  dark: AccentTokens;
  light: AccentTokens;
}

/** Accent base color for a theme (preset tuned value or the custom hex). */
export function accentBase(appearance: Settings['appearance'], theme: 'dark' | 'light'): string {
  if (appearance.accentPreset === 'custom') return appearance.accent;
  const preset = ACCENT_PRESETS[appearance.accentPreset] ?? ACCENT_PRESETS[DEFAULT_ACCENT_PRESET];
  return theme === 'light' ? (preset.light ?? preset.dark) : preset.dark;
}

/** The page, rail and menu colors for a theme after the user's custom colors (accent text sits on all three). */
export function textSurfaces(colors: Settings['appearance']['colors'], theme: 'dark' | 'light'): string[] {
  const custom = customColorVars(colors);
  const d = TEXT_SURFACES[theme];
  return [custom['--bg'] ?? d.bg, custom['--bg-elevated'] ?? d.elevated, custom['--surface-2'] ?? d.surface2];
}

export function accentTokens(appearance: Settings['appearance']): AccentReport {
  return {
    dark: deriveAccent(accentBase(appearance, 'dark'), 'dark', textSurfaces(appearance.colors, 'dark')),
    light: deriveAccent(accentBase(appearance, 'light'), 'light', textSurfaces(appearance.colors, 'light')),
  };
}

function customColorVars(colors: Settings['appearance']['colors']): Record<string, string> {
  const out: Record<string, string> = {};
  if (colors.background) {
    const bg = colors.background;
    const dir = isDark(bg) ? 1 : -1;
    out['--bg'] = bg;
    out['--bg-elevated'] = adjustLightness(bg, 0.022 * dir);
  }
  if (colors.surface) {
    const s = colors.surface;
    const dir = isDark(s) ? 1 : -1;
    out['--surface-1'] = s;
    out['--surface-2'] = adjustLightness(s, 0.03 * dir);
    out['--surface-3'] = adjustLightness(s, 0.065 * dir);
  }
  if (colors.text) out['--text'] = colors.text;
  if (colors.mutedText) {
    out['--text-2'] = colors.mutedText;
    const against = colors.background ?? (isDark(colors.mutedText) ? DEFAULT_BG.light : DEFAULT_BG.dark);
    // Tertiary text stays at AA (or as legible as the user's own muted color, if that is lower).
    const floor = Math.min(4.5, contrastRatio(colors.mutedText, against));
    out['--text-3'] = ensureContrast(mixOklab(colors.mutedText, against, 0.3), against, floor);
  }
  if (colors.border) {
    out['--hairline'] = withAlpha(colors.border, 0.55);
    out['--hairline-strong'] = colors.border;
  }
  return out;
}

function accentVars(t: AccentTokens): Record<string, string> {
  return {
    '--accent': t.accent,
    '--accent-strong': t.strong,
    '--accent-soft': t.soft,
    '--accent-ink': t.ink,
    '--focus': t.focus,
  };
}

/** Pure: settings → CSS variables/classes for both palettes. */
export function computeAppearance(settings: Settings): BootPayload {
  const a = settings.appearance;
  const vars: Record<string, string> = {
    '--font-size': `${a.fontSize}px`,
    '--font-ui': fontStack(a.fontFamily),
    '--density': String(DENSITY[a.density] ?? 1),
    '--radius': `${a.radius}px`,
    '--glass-opacity': String(a.transparency),
    '--blur': `${a.blur}px`,
    ...customColorVars(a.colors),
  };

  // The default accent on the default surfaces uses the hand-tuned tokens in tokens.css.
  const usesDesignAccent = a.accentPreset === DEFAULT_ACCENT_PRESET && !a.colors.background && !a.colors.surface;
  const tokens = usesDesignAccent ? null : accentTokens(a);
  const dark = tokens ? accentVars(tokens.dark) : {};
  const light = tokens ? accentVars(tokens.light) : {};

  const classes: string[] = [];
  if (a.reduceTransparency || a.blur === 0) classes.push('reduce-transparency');
  if (!settings.performance.gpuEffects) classes.push('no-gpu-effects');

  return {
    theme: a.theme,
    motion: a.animation,
    vars,
    dark,
    light,
    classes,
    meta: {
      dark: a.colors.background ?? DEFAULT_BG.dark,
      light: a.colors.background ?? DEFAULT_BG.light,
    },
  };
}

export interface Environment {
  prefersLight: boolean;
  prefersReducedMotion: boolean;
}

export function resolveTheme(theme: Theme, env: Pick<Environment, 'prefersLight'>): 'dark' | 'light' {
  return theme === 'system' ? (env.prefersLight ? 'light' : 'dark') : theme;
}

/** Effective motion: 'normal' follows the OS reduced-motion preference; explicit choices are respected. */
export function resolveMotion(motion: Motion, env: Pick<Environment, 'prefersReducedMotion'>): Motion {
  return motion === 'normal' && env.prefersReducedMotion ? 'reduced' : motion;
}

export interface ResolvedAppearance {
  theme: 'dark' | 'light';
  motion: Motion;
  scale: number;
  vars: Record<string, string>;
  classes: string[];
  metaColor: string;
}

/** Pure: payload + environment → the exact variables/classes to put on <html>. */
export function resolveAppearance(p: BootPayload, env: Environment): ResolvedAppearance {
  const theme = resolveTheme(p.theme, env);
  const motion = resolveMotion(p.motion, env);
  const scale = MOTION_SCALE[motion] ?? 1;
  const vars: Record<string, string> = {
    ...p.vars,
    ...(theme === 'light' ? p.light : p.dark),
    '--motion': String(scale),
    '--motion-move': motion === 'normal' || motion === 'expressive' ? '1' : '0',
  };
  const classes = [`theme-${theme}`, ...p.classes];
  if (motion === 'none') classes.push('motion-none');
  if (motion === 'reduced') classes.push('motion-reduced');
  return { theme, motion, scale, vars, classes, metaColor: theme === 'light' ? p.meta.light : p.meta.dark };
}

// ── DOM application ──────────────────────────────────────────────────────────────────────────────────────────────

const appliedVars = new Set<string>();
let motionScale = 1;
let motionMove = true;
const motionListeners = new Set<() => void>();

/** Current motion multiplier (0 none · 0.5 reduced · 1 normal · 1.25 expressive) for JS-driven transitions. */
export function getMotionScale(): number {
  return motionScale;
}

/** Whether translations are allowed (false for reduced / none: fades only). */
export function motionAllowsMovement(): boolean {
  return motionMove;
}

export function onMotionChange(fn: () => void): () => void {
  motionListeners.add(fn);
  return () => motionListeners.delete(fn);
}

export function applyAppearance(p: BootPayload, env: Environment, root: HTMLElement = document.documentElement): ResolvedAppearance {
  const r = resolveAppearance(p, env);
  // The boot script may have set variables this module does not know about yet; treat every var it could set as ours.
  for (const name of Array.from(root.style)) {
    if (name.startsWith('--')) appliedVars.add(name);
  }
  for (const name of appliedVars) {
    if (!(name in r.vars)) root.style.removeProperty(name);
  }
  appliedVars.clear();
  for (const [name, value] of Object.entries(r.vars)) {
    root.style.setProperty(name, value);
    appliedVars.add(name);
  }
  for (const cls of MANAGED_CLASSES) root.classList.toggle(cls, r.classes.includes(cls));
  root.style.colorScheme = r.theme;

  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="theme-color"]') : null;
  if (meta) meta.setAttribute('content', r.metaColor);

  const changed = motionScale !== r.scale || motionMove !== (r.vars['--motion-move'] === '1');
  motionScale = r.scale;
  motionMove = r.vars['--motion-move'] === '1';
  if (changed) for (const fn of motionListeners) fn();
  return r;
}
