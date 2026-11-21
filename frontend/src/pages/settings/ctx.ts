/** Search state shared by the settings page and its rows (rows hide themselves when they do not match). */
import { getContext, setContext } from 'svelte';

export interface SettingsSearch {
  readonly active: boolean;
  readonly terms: readonly string[];
  /** Matching rows as "<section>.<row id>". */
  readonly matches: ReadonlySet<string>;
}

const KEY = Symbol('gnome-settings-search');
const INACTIVE: SettingsSearch = { active: false, terms: [], matches: new Set() };

export function setSettingsSearch(s: SettingsSearch): void {
  setContext(KEY, s);
}

export function getSettingsSearch(): SettingsSearch {
  return getContext<SettingsSearch | undefined>(KEY) ?? INACTIVE;
}
