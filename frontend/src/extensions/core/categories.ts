/**
 * List groups, block categories and the toggles that govern them (WAVE-B3 D1, D2). Pure, DOM-free, compiled in every
 * scope (app, engine host, Worker, service worker).
 */
import type { BlockCategory, BlockerGroup, FilterCategory } from '../../shared/engine-protocol';

/** The group engine a list compiles into (WAVE-B3 D1). `resources` is not a filter list. */
export const GROUP_OF: Readonly<Record<Exclude<FilterCategory, 'resources'>, BlockerGroup>> = {
  ads: 'ads',
  security: 'security',
  privacy: 'trackers',
  urlparams: 'params',
  cookies: 'cookies',
  annoyances: 'annoyances',
};

/** What a block by a group engine counts as in tab.blocked. */
export const CATEGORY_OF: Readonly<Record<BlockerGroup, BlockCategory>> = {
  ads: 'ads',
  security: 'security',
  trackers: 'trackers',
  params: 'urlparams',
  cookies: 'cookies',
  annoyances: 'annoyances',
};

/** The `extensions.enabled` toggle that governs a group (D2). */
export const TOGGLE_OF: Readonly<Record<BlockerGroup, 'adblock' | 'trackers' | 'privacy' | 'cosmetic'>> = {
  ads: 'adblock',
  security: 'adblock',
  trackers: 'trackers',
  params: 'privacy',
  cookies: 'cosmetic',
  annoyances: 'cosmetic',
};

/** Network matching order: the first group that blocks decides (a badware match counts as `security`). */
export const MATCH_ORDER: readonly BlockerGroup[] = ['security', 'ads', 'trackers', 'cookies', 'annoyances'];
