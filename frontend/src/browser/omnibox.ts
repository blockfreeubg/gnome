/**
 * Address-bar suggestions (ARCHITECTURE §5.6): the primary action (open the address, search, or a GNOME page), then
 * bookmarks and history from the library (lane d), then search-engine suggestions fetched by the engine host
 * through the proxy transport (`suggest`, capability `suggest`; only while `browser.searchSuggestions` is on and only
 * for input that is not an address: ENGINE-PROTOCOL §6.12). Results from the engine host are validated by the
 * protocol and shown as text.
 */
import type { Suggestion } from '../shared/browser-data';
import { LIMITS, type SuggestProvider } from '../shared/engine-protocol';
import { displayUrl, parseOmnibox, type OmniboxResult, type SearchOptions } from '../lib/url';

export type OmniOption =
  | { key: string; kind: 'primary'; mode: 'url' | 'search' | 'internal'; title: string; detail: string; result: OmniboxResult }
  | { key: string; kind: 'site'; source: 'history' | 'bookmark'; url: string; title: string }
  | { key: string; kind: 'query'; text: string };

export function primaryOption(input: string, search: SearchOptions, engineName: string): OmniOption | null {
  const q = input.trim();
  if (!q) return null;
  const r = parseOmnibox(q, search);
  if (!r) return null;
  if (r.kind === 'url') return { key: 'primary', kind: 'primary', mode: 'url', title: displayUrl(r.href), detail: 'Open address', result: r };
  if (r.kind === 'internal') return { key: 'primary', kind: 'primary', mode: 'internal', title: q, detail: 'Open GNOME page', result: r };
  return { key: 'primary', kind: 'primary', mode: 'search', title: q, detail: `Search ${engineName}`, result: r };
}

/** Merges library suggestions (deduplicated by URL, best first) and search suggestions into the option list. */
export function mergeOptions(primary: OmniOption | null, library: readonly Suggestion[], queries: readonly string[], limit = 8): OmniOption[] {
  const out: OmniOption[] = primary ? [primary] : [];
  const seen = new Set<string>();
  if (primary?.kind === 'primary' && primary.mode === 'url') seen.add(primary.result.href);
  for (const s of [...library].sort((a, b) => b.score - a.score)) {
    if (out.length >= limit) break;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ key: `${s.source}:${s.url}`, kind: 'site', source: s.source, url: s.url, title: s.title || displayUrl(s.url) });
  }
  const typed = primary?.kind === 'primary' ? primary.title.toLowerCase() : '';
  const qs = new Set<string>();
  for (const q of queries) {
    if (qs.size >= 4) break;
    const t = q.trim();
    if (!t || t.toLowerCase() === typed || qs.has(t.toLowerCase())) continue;
    qs.add(t.toLowerCase());
    out.push({ key: `q:${t}`, kind: 'query', text: t });
  }
  return out;
}

/** Whether the engine host may be asked for suggestions for this input (never addresses, never too long). */
export function wantsSearchSuggestions(input: string, search: SearchOptions, enabled: boolean): SuggestProvider | null {
  if (!enabled || search.searchEngine === 'custom') return null;
  const q = input.trim();
  if (!q || q.length > LIMITS.maxSuggestQuery) return null;
  const r = parseOmnibox(q, search);
  if (!r || r.kind !== 'search') return null;
  return search.searchEngine;
}

/**
 * At most `perSecond` requests in any second, the newest input winning: `schedule(text)` returns the delay after
 * which the request for `text` may go out (debounce first, then the rate limit), or null when a newer input
 * replaced it.
 */
export class SuggestThrottle {
  readonly #sent: number[] = [];
  readonly #debounceMs: number;
  readonly #perSecond: number;
  constructor(debounceMs = 150, perSecond = 5) {
    this.#debounceMs = debounceMs;
    this.#perSecond = perSecond;
  }

  delay(now: number): number {
    while (this.#sent.length && (this.#sent[0] ?? 0) <= now - 1000) this.#sent.shift();
    const wait = this.#sent.length >= this.#perSecond ? (this.#sent[0] ?? now) + 1000 - now : 0;
    return Math.max(this.#debounceMs, wait);
  }

  /** Call when a request actually goes out. */
  sent(now: number): void {
    this.#sent.push(now);
  }
}
