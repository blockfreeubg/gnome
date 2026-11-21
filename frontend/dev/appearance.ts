/** Gallery/benchmark appearance: applied directly to <html>, never saved (the app's settings stay untouched). */
import { applyAppearance, computeAppearance } from '../src/settings/apply';
import { createDefaultSettings } from '../src/settings/defaults';
import type { AccentPreset, Motion, Theme } from '../src/settings/schema';

/** `accent` is a preset id, or a hex color for a custom accent (the gallery's `?accent=` parameter). */
export function applyGalleryAppearance(theme: Theme, motion: Motion, accent?: string): void {
  const s = createDefaultSettings();
  s.appearance.theme = theme;
  s.appearance.animation = motion;
  if (accent?.startsWith('#')) {
    s.appearance.accentPreset = 'custom';
    s.appearance.accent = accent;
  } else if (accent) {
    s.appearance.accentPreset = accent as AccentPreset;
  }
  applyAppearance(computeAppearance(s), {
    prefersLight: matchMedia('(prefers-color-scheme: light)').matches,
    prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
}
