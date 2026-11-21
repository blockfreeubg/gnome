/**
 * Route registry (docs/ARCHITECTURE.md §5.1). Built-in routes are registered below; feature teams extend the
 * registry by adding entries here or by calling `registerRoute()` from a module imported at startup.
 *
 * Each route lazy-loads its page chunk (`load`). Pages receive `{ params, query }` (PageProps).
 * `persistent` routes (the browser) stay mounted — hidden — while other routes are shown.
 * `section` decides which rail item is highlighted (defaults to the route id).
 */
import type { Component } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { LucideIcon } from '@lucide/svelte';
import Bookmark from '@lucide/svelte/icons/bookmark';
import Download from '@lucide/svelte/icons/download';
import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
import Globe from '@lucide/svelte/icons/globe';
import History from '@lucide/svelte/icons/history';
import House from '@lucide/svelte/icons/house';
import Info from '@lucide/svelte/icons/info';
import Puzzle from '@lucide/svelte/icons/puzzle';
import Settings from '@lucide/svelte/icons/settings';
import Shield from '@lucide/svelte/icons/shield';
import type { ShortcutAction } from '../settings/schema';
import { buildPath, compilePattern, matchPattern, type CompiledPattern } from './match';

export interface PageProps {
  params: Record<string, string>;
  query: URLSearchParams;
}

/** Props for persistent pages (the browser host). */
export interface PersistentPageProps extends PageProps {
  /** True while the route is the visible one. */
  active: boolean;
}

/** A lazily loaded page: regular pages take PageProps, persistent pages also receive `active`. */
export type PageComponent = Component<PageProps> | Component<PersistentPageProps>;
export interface PageModule {
  default: PageComponent;
}

export interface RouteNav {
  label: string;
  icon: LucideIcon;
  /** 'main' = middle of the rail, 'bottom' = bottom group (Settings, About). */
  group: 'main' | 'bottom';
  /** Sort key; the hundreds digit is the visual cluster (100 browse · 200 protection · 300 library). */
  order: number;
  /** Shown directly in the mobile bottom bar (others are in the "More" sheet). */
  mobile?: boolean;
  /** Shortcut hint shown in tooltips and the command palette. */
  shortcut?: ShortcutAction;
}

export interface RouteDef {
  id: string;
  path: string;
  /** Document title (without the " · GNOME" suffix). */
  title: string | ((params: Record<string, string>) => string);
  /** One line for the command palette. */
  description?: string;
  keywords?: string[];
  load: () => Promise<PageModule>;
  section?: string;
  nav?: RouteNav;
  persistent?: boolean;
  /** List in the command palette's navigation group (default: true for nav routes). */
  palette?: boolean;
}

interface Entry {
  def: RouteDef;
  compiled: CompiledPattern;
}

const registry = new SvelteMap<string, Entry>();
const loaded = new Map<string, Promise<PageModule>>();

export function registerRoute(def: RouteDef): () => void {
  if (registry.has(def.id)) console.warn(`[gnome] route "${def.id}" registered twice; replacing`);
  const entry: Entry = { def, compiled: compilePattern(def.path) };
  registry.set(def.id, entry);
  return () => {
    if (registry.get(def.id) === entry) registry.delete(def.id);
  };
}

export function routeById(id: string): RouteDef | undefined {
  return registry.get(id)?.def;
}

/** All routes, most specific pattern first (reactive). */
export function allRoutes(): RouteDef[] {
  return [...registry.values()].sort((a, b) => b.compiled.score - a.compiled.score).map((e) => e.def);
}

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

/** Resolves a pathname; falls back to the not-found route. */
export function matchRoute(pathname: string): RouteMatch {
  const entries = [...registry.values()].sort((a, b) => b.compiled.score - a.compiled.score);
  for (const e of entries) {
    if (e.def.id === NOT_FOUND_ID) continue;
    const params = matchPattern(e.compiled, pathname);
    if (params) return { route: e.def, params };
  }
  const nf = registry.get(NOT_FOUND_ID);
  if (!nf) throw new Error('not-found route missing');
  return { route: nf.def, params: { wildcard: pathname } };
}

/** Rail / bottom-bar entries for a group, ordered (reactive). */
export function navRoutes(group: RouteNav['group']): Array<RouteDef & { nav: RouteNav }> {
  return [...registry.values()]
    .map((e) => e.def)
    .filter((d): d is RouteDef & { nav: RouteNav } => d.nav?.group === group)
    .sort((a, b) => a.nav.order - b.nav.order);
}

/** Destinations shown directly in the mobile bottom bar (at most four; the fifth slot is "More"). */
export const MOBILE_BAR_SLOTS = 4;

/**
 * The mobile bottom bar's split of the nav routes (reactive): `bar` = shown directly, `more` = listed in the "More"
 * sheet (every other main route, then the bottom group).
 */
export function mobileNav(): { bar: Array<RouteDef & { nav: RouteNav }>; more: Array<RouteDef & { nav: RouteNav }> } {
  const main = navRoutes('main');
  const bar = main.filter((r) => r.nav.mobile).slice(0, MOBILE_BAR_SLOTS);
  return { bar, more: [...main.filter((r) => !bar.includes(r)), ...navRoutes('bottom')] };
}

export function routeTitle(route: RouteDef, params: Record<string, string>): string {
  return typeof route.title === 'function' ? route.title(params) : route.title;
}

/** Loads (once) and returns the page module; a failed load is retried on the next call. */
export function loadRoute(route: RouteDef): Promise<PageModule> {
  let p = loaded.get(route.id);
  if (!p) {
    p = route.load().catch((err: unknown) => {
      loaded.delete(route.id);
      throw err;
    });
    loaded.set(route.id, p);
  }
  return p;
}

export function pathFor(id: string, params: Record<string, string | number> = {}): string {
  const def = routeById(id);
  if (!def) throw new Error(`Unknown route "${id}"`);
  return buildPath(def.path, params);
}

export const NOT_FOUND_ID = 'not-found';

// ── Built-in routes ──────────────────────────────────────────────────────────────────────────────────────────────

registerRoute({
  id: 'home',
  path: '/',
  title: 'Home',
  description: 'Search, quick links and recent sites',
  keywords: ['start', 'new tab', 'search'],
  load: () => import('../pages/home/HomePage.svelte'),
  nav: { label: 'Home', icon: House, group: 'main', order: 110, mobile: true, shortcut: 'home' },
});

registerRoute({
  id: 'browse',
  path: '/browse',
  title: 'Browser',
  description: 'Your open tabs',
  keywords: ['tabs', 'web', 'proxy'],
  persistent: true,
  load: () => import('../pages/browser/BrowserHost.svelte'),
  nav: { label: 'Browser', icon: Globe, group: 'main', order: 120, mobile: true },
});

registerRoute({
  id: 'games',
  path: '/games',
  title: 'Games',
  description: 'Free web games from licensed publishers',
  keywords: ['play', 'catalog'],
  load: () => import('../pages/games/GamesPage.svelte'),
  nav: { label: 'Games', icon: Gamepad2, group: 'main', order: 130, mobile: true, shortcut: 'openGames' },
});

registerRoute({
  id: 'game',
  path: '/games/:slug',
  title: 'Game',
  section: 'games',
  palette: false,
  load: () => import('../pages/games/GameDetailPage.svelte'),
});

registerRoute({
  id: 'play',
  path: '/play/:slug',
  title: 'Play',
  section: 'games',
  palette: false,
  load: () => import('../pages/games/PlayPage.svelte'),
});

registerRoute({
  id: 'extensions',
  path: '/extensions',
  title: 'Extensions',
  description: 'Ad, tracker and cookie blocking',
  keywords: ['adblock', 'privacy', 'filters', 'shields'],
  load: () => import('../pages/extensions/ExtensionsPage.svelte'),
  nav: { label: 'Extensions', icon: Puzzle, group: 'main', order: 210 },
});

registerRoute({
  id: 'vpn',
  path: '/vpn',
  title: 'VPN',
  description: 'Route pages through an egress gateway',
  keywords: ['location', 'gateway', 'exit'],
  load: () => import('../pages/vpn/VpnPage.svelte'),
  nav: { label: 'VPN', icon: Shield, group: 'main', order: 220, mobile: true },
});

registerRoute({
  id: 'history',
  path: '/history',
  title: 'History',
  description: 'Pages you visited',
  load: () => import('../pages/history/HistoryPage.svelte'),
  nav: { label: 'History', icon: History, group: 'main', order: 310, shortcut: 'openHistory' },
});

registerRoute({
  id: 'bookmarks',
  path: '/bookmarks',
  title: 'Bookmarks',
  description: 'Saved pages and folders',
  load: () => import('../pages/bookmarks/BookmarksPage.svelte'),
  nav: { label: 'Bookmarks', icon: Bookmark, group: 'main', order: 320, shortcut: 'openBookmarks' },
});

registerRoute({
  id: 'downloads',
  path: '/downloads',
  title: 'Downloads',
  description: 'Files saved from pages',
  load: () => import('../pages/downloads/DownloadsPage.svelte'),
  nav: { label: 'Downloads', icon: Download, group: 'main', order: 330, shortcut: 'openDownloads' },
});

registerRoute({
  id: 'settings',
  path: '/settings',
  title: 'Settings',
  description: 'Appearance, privacy, shortcuts and more',
  keywords: ['preferences', 'options', 'theme'],
  load: () => import('../pages/settings/SettingsPage.svelte'),
  nav: { label: 'Settings', icon: Settings, group: 'bottom', order: 10, shortcut: 'openSettings' },
});

registerRoute({
  id: 'settings-section',
  path: '/settings/:section',
  title: 'Settings',
  section: 'settings',
  palette: false,
  load: () => import('../pages/settings/SettingsPage.svelte'),
});

registerRoute({
  id: 'about',
  path: '/about',
  title: 'About',
  description: 'Version, licenses and source code',
  keywords: ['licenses', 'version', 'source'],
  load: () => import('../pages/about/AboutPage.svelte'),
  nav: { label: 'About', icon: Info, group: 'bottom', order: 20 },
});

registerRoute({
  id: NOT_FOUND_ID,
  path: '*',
  title: 'Page not found',
  palette: false,
  load: () => import('../pages/notfound/NotFoundPage.svelte'),
});
