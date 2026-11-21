/**
 * Which parts of GNOME are present in this build and act on their settings.
 *
 * Every key in schema.ts must be consumed by real behaviour, and the Settings page must not offer a control that
 * does nothing (docs/ARCHITECTURE.md §5.3). Some keys belong to features that register themselves when they start
 * (the tabbed browser and engine host, the built-in extensions, the VPN gateway client, the games catalog): until
 * then, Settings hides the rows for those keys (pages/settings/registry.ts `needs`), and About lists only shortcuts
 * that work.
 *
 *   // in the feature's start-up code, once it really applies its settings:
 *   const off = registerFeature('browser');
 */
import { SvelteSet } from 'svelte/reactivity';
import type { ShortcutAction } from './schema';

export type Feature = 'browser' | 'extensions' | 'vpn' | 'games';

export const FEATURES: readonly Feature[] = ['browser', 'extensions', 'vpn', 'games'];

/** How Settings and About name a feature in sentences ("… once the built-in browser is available"). */
export const FEATURE_NAMES: Readonly<Record<Feature, string>> = {
  browser: 'the built-in browser',
  extensions: 'the built-in extensions',
  vpn: 'the VPN gateway client',
  games: 'the games catalog',
};

const active = new SvelteSet<Feature>();

/** Marks a feature as present. Returns an unregister function (for tests and hot reload). */
export function registerFeature(feature: Feature): () => void {
  active.add(feature);
  return () => {
    active.delete(feature);
  };
}

/** Whether a feature is present (reactive in components, effects and $derived). */
export function isFeatureActive(feature: Feature): boolean {
  return active.has(feature);
}

/**
 * Shortcuts the app shell handles in every build (app/builtin.ts). The others act on tabs and pages of the built-in
 * browser, which registers their handlers.
 */
export const SHELL_SHORTCUTS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'commandPalette',
  'toggleSidebar',
  'home',
  'openHistory',
  'openBookmarks',
  'openDownloads',
  'openGames',
  'openSettings',
]);

/** Whether a shortcut does something in this build (reactive). */
export function shortcutActive(action: ShortcutAction): boolean {
  return SHELL_SHORTCUTS.has(action) || isFeatureActive('browser');
}
