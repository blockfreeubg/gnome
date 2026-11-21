/**
 * The engine host's providers beside `network` (WAVE-B3 §4.1, §13 items 5–6): the only file of the engine host that
 * imports lane x2's and lane x3's factories (wired once each lane reported them landed: x3 12:20, x2 14:30 on
 * 2026-11-19). Order after network: cookies, privacy (document overrides before scriptlets), cosmetic.
 */
import type { Natives } from '../../engine-host/natives';
import type { PageKit } from '../../engine-host/realm';
import type { HookProvider } from '../core/compose';
import { withCookieDocument } from '../cookies/document';
import { createCookieProvider } from '../cookies/provider';
import { createCosmeticProvider } from '../cosmetic/provider';
import type { FilterEngines } from '../filters/engines';
import { withPrivacyDocument } from '../privacy/document';
import { createPrivacyProvider } from '../privacy/provider';

export interface WindowProviderDeps {
  N: Natives;
  engines: FilterEngines;
  kitOf(win: Window): PageKit | null;
  withPageAssignments(win: Window, run: () => void): void;
  log(level: 'warn' | 'error', message: string): void;
}

/** x3's cookie and privacy providers (with their document parts), then x2's cosmetic provider. */
export function windowProviders(deps: WindowProviderDeps): HookProvider[] {
  const { N, engines } = deps;
  const kitOf = (w: Window): PageKit | null => deps.kitOf(w);
  return [
    withCookieDocument(createCookieProvider(), { N, kitOf }),
    withPrivacyDocument(createPrivacyProvider({ rewriteParams: (u, d, t) => engines.rewriteParams(u, d, t) }), { N, kitOf }),
    createCosmeticProvider(deps),
  ];
}
