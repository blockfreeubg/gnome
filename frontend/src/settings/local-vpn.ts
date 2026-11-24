/**
 * `vpn.mode` (this browser's connection switch) and `vpn.killSwitch` are device-local (docs/WAVE-C.md D12), the
 * home-picture pattern (`local-picture.ts`): a document that arrives from elsewhere (account sync, a merge, an imported
 * settings file) never changes them in this browser. An action on one device must not lower protection on another,
 * and an imported file must not route (or, with the kill switch, block) a browser that never chose it.
 *
 * Uploads are unchanged (`syncedPart()`): the server copy may carry this device's values, which every other device
 * ignores. Because the server copy is rewritten with the local values before the merge, the merge never sees a
 * difference in these keys, so devices with different switches do not upload back and forth.
 */
import type { Settings } from './schema';

export type DeviceVpn = Pick<Settings['vpn'], 'mode' | 'killSwitch'>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `doc` (a plain-object document from sync, a merge or an import) with this browser's `vpn.mode` and
 * `vpn.killSwitch` put back; a document without a `vpn` object gets one with just these two keys. Anything that is
 * not a plain object is returned unchanged (the validator rejects or repairs it).
 */
export function withLocalVpn<T>(doc: T, device: DeviceVpn): T {
  if (!isRecord(doc)) return doc;
  const vpn = isRecord(doc.vpn) ? doc.vpn : {};
  return { ...doc, vpn: { ...vpn, mode: device.mode, killSwitch: device.killSwitch } } as T;
}
