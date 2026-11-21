/** Small display helpers shared by the browser view's components. */
import { displayUrl } from '../../lib/url';
import type { Tab } from '../tabs.svelte';

export function titleOf(t: Pick<Tab, 'title' | 'url'> & { error?: Tab['error'] }): string {
  // A failed navigation names the address that failed (its page never committed, so its title is not the tab's).
  if (t.error?.url) return displayUrl(t.error.url);
  if (t.title) return t.title;
  if (t.url) return displayUrl(t.url);
  return 'New tab';
}

/**
 * The tab's icon: none while its last navigation failed (the icon belongs to the page before, whose address the tab
 * no longer shows).
 */
export function faviconOf(t: Pick<Tab, 'favicon' | 'error'>): string | null {
  return t.error ? null : t.favicon;
}

/** The address a tab names: the one that failed while the error overlay shows, else its page's. */
export function addressOf(t: Pick<Tab, 'url' | 'error'>): string | null {
  return t.error?.url ?? t.url;
}

/** Short engine badge text (DESIGN.md §8: "SJ"/"UV"). */
export const ENGINE_SHORT = { scramjet: 'SJ', ultraviolet: 'UV' } as const;
