/**
 * The `allow` attribute of a tab iframe (ENGINE-PROTOCOL §6.14): `tabFrameAllow()` of the contract, with only the
 * features this browser enforces (InitResult.enforcedPermissions). A feature left out keeps its default allowlist
 * (`'self'`), which allows it in the tab frame (same-origin with the engine host) exactly as listing it does, so the
 * behaviour is the same; but Firefox, which implements neither `autoplay` nor `clipboard-write`, logs "Feature Policy:
 * Skipping unsupported feature name" for each of them on every tab frame (worklist A8). Chromium enforces fullscreen
 * and autoplay; clipboard is enforced nowhere (shared/site-rules.ts ENFORCED_PERMISSIONS), so its default `'self'`
 * allowlist lets proxied pages write the clipboard as in a normal browser.
 */
import type { EnginePermission, EnginePermissionSet } from '../shared/engine-protocol';
import { PERMISSION_FEATURES, tabFrameAllow } from '../shared/site-rules';

export function tabFrameAllowList(perms: EnginePermissionSet, enforced: readonly EnginePermission[]): string {
  const keep = new Set(enforced.map((p) => PERMISSION_FEATURES[p]));
  return tabFrameAllow(perms, enforced)
    .split('; ')
    .filter((entry) => keep.has(entry.split(' ')[0] ?? ''))
    .join('; ');
}
