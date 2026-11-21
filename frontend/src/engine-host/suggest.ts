/**
 * Search suggestions (capability `suggest`, ENGINE-PROTOCOL §6.12): the provider's OpenSearch suggestion endpoint,
 * fetched with TransportManager.proxyFetch (through Wisp: no engine, no cookies, never through GNOME's server), and
 * its answer cut to at most LIMITS.maxSuggestions strings of at most LIMITS.maxSuggestionLength characters.
 *
 * The endpoint table was checked by hand on 2026-11-12 (each answers the OpenSearch suggestions JSON
 * `[query, [suggestion, …], …]`): DuckDuckGo, Google (`client=firefox`, UTF-8 forced), Bing, Brave and Startpage
 * answered; Ecosia's own OpenSearch template (`ac.ecosia.org/autocomplete?type=list`) answered 503 to a direct
 * request at that time. Which of them work through the engine host is the e2e suite's question (host-capabilities).
 */
import { LIMITS, fitText, sanitizeText } from '../shared/engine-protocol';
import type { SuggestProvider } from '../shared/engine-protocol';
import type { ProxyFetchInit, ProxyFetchResult } from '../shared/transport';

/** `{q}` is replaced by the encoded query. */
export const SUGGEST_ENDPOINTS: Readonly<Record<SuggestProvider, string>> = {
  duckduckgo: 'https://duckduckgo.com/ac/?q={q}&type=list',
  google: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q={q}',
  bing: 'https://api.bing.com/osjson.aspx?query={q}',
  brave: 'https://search.brave.com/api/suggest?q={q}',
  startpage: 'https://www.startpage.com/osuggestions?q={q}',
  ecosia: 'https://ac.ecosia.org/autocomplete?q={q}&type=list',
};

export const SUGGEST_FETCH: ProxyFetchInit = { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 4000, maxBytes: 64 * 1024 };

export function suggestUrl(provider: SuggestProvider, query: string): string {
  return SUGGEST_ENDPOINTS[provider].replace('{q}', encodeURIComponent(query));
}

/**
 * The suggestions of an OpenSearch suggestions answer (`[query, string[], …]`): strings only, control and
 * bidirectional characters removed, cut to the protocol's limits, empty and duplicate items dropped.
 */
export function parseSuggestions(body: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('the suggestion service answered something that is not JSON');
  }
  if (!Array.isArray(data) || !Array.isArray(data[1])) throw new Error('the suggestion service answered an unknown format');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of data[1] as unknown[]) {
    if (typeof item !== 'string') continue;
    const s = fitText(sanitizeText(item).trim(), LIMITS.maxSuggestionLength);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= LIMITS.maxSuggestions) break;
  }
  return out;
}

export async function suggest(
  proxyFetch: (url: string, init: ProxyFetchInit) => Promise<ProxyFetchResult>,
  provider: SuggestProvider,
  query: string,
): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const r = await proxyFetch(suggestUrl(provider, q), SUGGEST_FETCH);
  if (r.status < 200 || r.status >= 300) throw new Error(`the suggestion service answered ${r.status}`);
  return parseSuggestions(new TextDecoder('utf-8').decode(r.body));
}
