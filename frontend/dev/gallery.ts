/**
 * Dev-only entry for the component gallery (dev/gallery.html) and the VirtualGrid benchmark (dev/virtual-grid.html).
 * Appearance comes from the query string instead of the settings store, so opening these pages never changes the
 * app's saved settings on the dev origin.
 */
import '../src/styles/fonts.css';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/utilities.css';

import { mount } from 'svelte';
import { ACCENT_PRESETS } from '../src/settings/apply';
import { applyGalleryAppearance } from './appearance';
import Gallery from './Gallery.svelte';
import VirtualGridBench from './VirtualGridBench.svelte';

const params = new URLSearchParams(location.search);
const theme = (['dark', 'light', 'system'] as const).find((t) => t === params.get('theme')) ?? 'dark';
const motion = (['none', 'reduced', 'normal', 'expressive'] as const).find((m) => m === params.get('motion')) ?? 'normal';

// ?accent=<preset id> or ?accent=%23rrggbb: review the components under another accent (never saved).
const accentParam = params.get('accent') ?? '';
const accent = accentParam.startsWith('#') || accentParam in ACCENT_PRESETS ? accentParam : undefined;

applyGalleryAppearance(theme, motion, accent);

const target = document.getElementById('app');
if (!target) throw new Error('#app element missing');
if (location.pathname.endsWith('/virtual-grid.html')) {
  const count = Math.max(1, Math.min(200_000, Number(params.get('count')) || 10_000));
  mount(VirtualGridBench, { target, props: { count } });
} else {
  mount(Gallery, { target, props: { theme, motion, accent } });
}
