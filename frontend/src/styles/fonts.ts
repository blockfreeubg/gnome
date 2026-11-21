/**
 * UI font choices (Settings → Appearance → Font). The @font-face rules live in fonts.css and are lazy, so a family
 * is only downloaded when it is actually used. `warmFont` lets the settings UI start the download as soon as the
 * user picks a family, so the switch does not flash the fallback.
 *
 * Design v2 (docs/DESIGN.md §4): Inter is the default interface font; Montserrat is the display face (wordmark,
 * page titles, headings) whatever the interface font, and can also be picked as the interface font.
 */
import type { Settings } from '../settings/schema';

export type UiFontId = Settings['appearance']['fontFamily'];

const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** The interface font when nothing (valid) is chosen. */
export const DEFAULT_UI_FONT: UiFontId = 'inter';

export interface FontChoice {
  id: UiFontId;
  label: string;
  /** One line for the font picker. */
  description: string;
  /** Primary family name as declared in fonts.css (null = system font, nothing to download). */
  family: string | null;
  stack: string;
}

/** In the order the font picker lists them. */
export const UI_FONTS: Readonly<Record<UiFontId, FontChoice>> = {
  inter: { id: 'inter', label: 'Inter', description: 'Default', family: 'Inter Variable', stack: `'Inter Variable', ${SANS_FALLBACK}` },
  montserrat: {
    id: 'montserrat',
    label: 'Montserrat',
    description: 'Geometric, like the headings',
    family: 'Montserrat Variable',
    stack: `'Montserrat Variable', ${SANS_FALLBACK}`,
  },
  geist: { id: 'geist', label: 'Geist', description: 'Neutral sans-serif', family: 'Geist Variable', stack: `'Geist Variable', ${SANS_FALLBACK}` },
  system: { id: 'system', label: 'System', description: 'Your device’s interface font', family: null, stack: SANS_FALLBACK },
  atkinson: {
    id: 'atkinson',
    label: 'Atkinson Hyperlegible Next',
    description: 'Designed for low vision',
    family: 'Atkinson Hyperlegible Next Variable',
    stack: `'Atkinson Hyperlegible Next Variable', ${SANS_FALLBACK}`,
  },
  fraunces: {
    id: 'fraunces',
    label: 'Fraunces',
    description: 'Serif',
    family: 'Fraunces Variable',
    stack: "'Fraunces Variable', Georgia, 'Times New Roman', serif",
  },
  mono: {
    id: 'mono',
    label: 'Geist Mono',
    description: 'Monospaced',
    family: 'Geist Mono Variable',
    stack: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
};

export function fontStack(id: UiFontId): string {
  return (UI_FONTS[id] ?? UI_FONTS[DEFAULT_UI_FONT]).stack;
}

/** Starts downloading the latin subset of a UI font (no-op for the system font or without the Font Loading API). */
export function warmFont(id: UiFontId): Promise<void> {
  const family = UI_FONTS[id]?.family;
  if (!family || typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve();
  return document.fonts
    .load(`400 1em '${family}'`, 'GNOME')
    .then(() => undefined)
    .catch(() => undefined);
}
