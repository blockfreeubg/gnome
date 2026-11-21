/**
 * Scoped site maps (WAVE-B3 D5): the engine host gets the user's `allowlist` and `perSite` entries only for sites it
 * already shows or is about to load, because a hostile page in the engine host can read everything the app sends
 * (ENGINE-PROTOCOL §1.2 rule 4).
 *
 * One SiteExposure per app page, kept across engine-host replacements (the app replaces the engine iframe on every
 * unexpected load, so a per-connection budget would reset). `expose(url, tabId, reason)` runs for every GNOME-initiated
 * load (before its command), every entry of a tab the app creates or restores, every `tab.loading.url` and every
 * `tab.committed.url`. An exposure that adds no allowlist or per-site entry to the scope costs nothing; one that does
 * counts against the budget: at most 20 newly exposed rule-bearing sites per tab per minute and 120 per app page per
 * hour for `nav-start`/`commit` (what a page can cause or forge); GNOME-initiated loads and restored entries always
 * pass. Beyond the budget the site is not exposed: it gets the global settings, and the drop is counted.
 *
 * After two compromise signals (ENGINE-PROTOCOL §1.2 rule 8) in this app page, `scoped()` returns empty maps for the
 * rest of it: the shield and the Extensions page then say that site rules are paused.
 *
 * Pure (a clock is injected); src/browser/browser.svelte.ts drives it.
 */
import { siteKeysFor } from '../../shared/site-rules';
import type { Settings } from '../../settings/schema';

export type ExposureReason = 'gnome-load' | 'restore' | 'nav-start' | 'commit';
/** `free`: nothing new with a rule; `added`: rule-bearing keys joined the scope; `dropped`: over the budget, not exposed. */
export type ExposureResult = 'free' | 'added' | 'dropped';

export const EXPOSURE_BUDGET = { perTabPerMinute: 20, perPagePerHour: 120 } as const;
/** Compromise signals in one app page after which site rules are no longer sent (WAVE-B3 D5). */
export const EXPOSURE_PAUSE_SIGNALS = 2;
/** Rule-free keys remembered (so a rule the user adds later, e.g. in Settings, reaches a site that is open). */
const MAX_KEYS = 8192;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type SiteMaps = Pick<Settings['extensions'], 'allowlist' | 'perSite'>;

export interface ScopedMaps {
  allowlist: string[];
  perSite: Settings['extensions']['perSite'];
}

export class SiteExposure {
  readonly #now: () => number;
  /** Keys exposed while they carried a rule (bounded by the budget, or by GNOME's own loads): kept for the app page. */
  readonly #ruled = new Set<string>();
  /** Keys exposed without a rule, oldest first, at most MAX_KEYS (a rule added later still reaches an open site). */
  readonly #free = new Set<string>();
  /** Budgeted exposures: per tab (last minute) and per page (last hour). */
  readonly #tabHits = new Map<number, number[]>();
  #pageHits: number[] = [];
  #signals = 0;
  /** Exposures refused by the budget (diagnostics). */
  dropped = 0;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Site rules are no longer sent in this app page (two compromise signals). */
  get paused(): boolean {
    return this.#signals >= EXPOSURE_PAUSE_SIGNALS;
  }

  /** The engine client's compromise-signal count (it only grows within an app page). */
  setCompromiseSignals(n: number): void {
    if (n > this.#signals) this.#signals = n;
  }

  #has(k: string): boolean {
    return this.#ruled.has(k) || this.#free.has(k);
  }

  /** Whether every key of `url` is in the scope. */
  isExposed(url: string): boolean {
    const keys = siteKeysFor(url);
    return keys.length > 0 && keys.every((k) => this.#has(k));
  }

  expose(url: string, tabId: number | null, reason: ExposureReason, maps: SiteMaps): ExposureResult {
    const keys = siteKeysFor(url);
    if (!keys.length) return 'free';
    const allow = new Set(maps.allowlist);
    const hasRule = (k: string): boolean => allow.has(k) || Object.prototype.hasOwnProperty.call(maps.perSite, k);
    const fresh = keys.filter((k) => !this.#ruled.has(k) && !(this.#free.has(k) && !hasRule(k)));
    // A key exposed before without a rule that has one now joins the ruled set at no cost: it was already in scope.
    const newlyRuled = fresh.filter((k) => hasRule(k) && !this.#free.has(k));
    if (newlyRuled.length && (reason === 'nav-start' || reason === 'commit')) {
      const now = this.#now();
      if (!this.#withinBudget(tabId, now)) {
        this.dropped++;
        return 'dropped';
      }
      this.#count(tabId, now);
    }
    for (const k of keys) {
      if (hasRule(k)) {
        this.#free.delete(k);
        this.#ruled.add(k);
      } else if (!this.#ruled.has(k)) {
        this.#free.delete(k);
        this.#free.add(k);
        if (this.#free.size > MAX_KEYS) this.#free.delete(this.#free.values().next().value as string);
      }
    }
    return newlyRuled.length ? 'added' : 'free';
  }

  #withinBudget(tabId: number | null, now: number): boolean {
    this.#pageHits = this.#pageHits.filter((t) => now - t < HOUR);
    if (this.#pageHits.length >= EXPOSURE_BUDGET.perPagePerHour) return false;
    if (tabId === null) return true;
    const hits = (this.#tabHits.get(tabId) ?? []).filter((t) => now - t < MINUTE);
    this.#tabHits.set(tabId, hits);
    return hits.length < EXPOSURE_BUDGET.perTabPerMinute;
  }

  #count(tabId: number | null, now: number): void {
    this.#pageHits.push(now);
    if (tabId !== null) this.#tabHits.set(tabId, [...(this.#tabHits.get(tabId) ?? []), now]);
  }

  /** A tab closed: its per-minute window goes (the page-wide hour budget stays). */
  forgetTab(tabId: number): void {
    this.#tabHits.delete(tabId);
  }

  /**
   * The `allowlist` and `perSite` entries the engine host may receive: those whose keys are among the keys of the
   * exposed URLs (`siteKeysFor`). Empty after two compromise signals.
   */
  scoped(maps: SiteMaps): ScopedMaps {
    if (this.paused) return { allowlist: [], perSite: {} };
    const allowlist = maps.allowlist.filter((k) => this.#has(k));
    const perSite: ScopedMaps['perSite'] = {};
    for (const [k, v] of Object.entries(maps.perSite)) if (this.#has(k)) perSite[k] = v;
    return { allowlist, perSite };
  }
}
