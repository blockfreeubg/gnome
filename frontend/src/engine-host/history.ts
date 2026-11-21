/**
 * A tab's back/forward list as the engine host keeps it (ENGINE-PROTOCOL §6.1): real URLs, oldest first, at most
 * LIMITS.maxTabHistory entries (the oldest is dropped, as browsers do). Every commit reports `historyHandling`,
 * `index` and `length` from here, and `tab.state` returns the whole list. Pure: no DOM.
 *
 * The entries keep the full URL; what crosses the protocol is fitted with reportUrl() (a URL over LIMITS.maxUrlLength
 * is reported as its origin and path only).
 */
import { LIMITS, normalizeHttpUrl } from '../shared/engine-protocol';
import type { HistoryHandling } from '../shared/engine-protocol';

export interface HistoryPosition {
  index: number;
  length: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * The URL as the protocol may carry it: normalized http(s) (credentials removed), or, when it is longer than the
 * limit, its origin and path without query and fragment, cut to the limit. Null for anything that is not http(s).
 */
export function reportUrl(url: string): string | null {
  const direct = normalizeHttpUrl(url.length > LIMITS.maxUrlLength ? '' : url);
  if (direct) return direct;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const short = `${u.origin}${u.pathname}`;
  if (short.length <= LIMITS.maxUrlLength) return normalizeHttpUrl(short);
  // A path longer than the limit: keep what fits (cut at a code point boundary of the serialized form).
  return normalizeHttpUrl(short.slice(0, LIMITS.maxUrlLength)) ?? normalizeHttpUrl(u.origin + '/');
}

export class TabHistory {
  #entries: string[] = [];
  #index = 0;
  readonly #max: number;

  constructor(max: number = LIMITS.maxTabHistory) {
    this.#max = max;
  }

  get entries(): readonly string[] {
    return this.#entries;
  }

  get index(): number {
    return this.#index;
  }

  get length(): number {
    return this.#entries.length;
  }

  get current(): string | null {
    return this.#entries[this.#index] ?? null;
  }

  at(i: number): string | null {
    return this.#entries[i] ?? null;
  }

  position(): HistoryPosition {
    const length = this.#entries.length;
    return { index: this.#index, length, canGoBack: this.#index > 0, canGoForward: this.#index < length - 1 };
  }

  /** Session restore / un-discard: the list as the app had it (already validated: 1..max entries, index inside). */
  restore(entries: readonly string[], index: number): void {
    const list = entries.slice(-this.#max);
    const dropped = entries.length - list.length;
    this.#entries = list;
    this.#index = Math.min(Math.max(0, index - dropped), list.length - 1);
  }

  /** A new entry after the current one; the forward entries are dropped, then the oldest beyond the cap. */
  push(url: string): void {
    if (this.#entries.length === 0) {
      this.#entries = [url];
      this.#index = 0;
      return;
    }
    this.#entries = this.#entries.slice(0, this.#index + 1);
    this.#entries.push(url);
    while (this.#entries.length > this.#max) this.#entries.shift();
    this.#index = this.#entries.length - 1;
  }

  /** Overwrites the current entry (the first entry when the list is empty). */
  replace(url: string): void {
    if (this.#entries.length === 0) {
      this.push(url);
      return;
    }
    this.#entries[this.#index] = url;
  }

  /** Moves to entry `index` and sets it to `url` (the document may have redirected). */
  traverse(index: number, url: string): void {
    if (index < 0 || index >= this.#entries.length) {
      this.push(url);
      return;
    }
    this.#index = index;
    this.#entries[index] = url;
  }

  apply(handling: HistoryHandling, url: string, index?: number): void {
    if (handling === 'push') this.push(url);
    else if (handling === 'replace') this.replace(url);
    else this.traverse(index ?? this.#index, url);
  }

  /**
   * The entry a traversal to `url` lands on: the neighbouring entry whose URL matches, back first (ENGINE-PROTOCOL
   * §6.1), then any other matching entry nearest to the current one; null without a match.
   */
  findTraversal(url: string): number | null {
    const i = this.#index;
    if (this.#entries[i - 1] === url) return i - 1;
    if (this.#entries[i + 1] === url) return i + 1;
    for (let d = 2; d < this.#entries.length; d++) {
      if (this.#entries[i - d] === url) return i - d;
      if (this.#entries[i + d] === url) return i + d;
    }
    return null;
  }

  /** The entries as the protocol reports them (tab.state): fitted URLs, entries that cannot be reported dropped. */
  reported(): { entries: string[]; index: number } {
    const entries: string[] = [];
    let index = 0;
    this.#entries.forEach((u, i) => {
      const r = reportUrl(u);
      if (r === null) return;
      if (i <= this.#index) index = entries.length;
      entries.push(r);
    });
    return { entries, index: entries.length ? Math.min(index, entries.length - 1) : 0 };
  }
}
