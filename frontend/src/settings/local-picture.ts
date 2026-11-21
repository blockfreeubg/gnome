/**
 * Home background pictures uploaded in Settings → Appearance are stored in this browser's IndexedDB (`kv`, key
 * `home-bg:<uuid>`) and referenced from the setting as `idb:<key>`. The picture itself never leaves the browser, so:
 * - a reference that arrives from elsewhere (account sync, an imported settings file) points to nothing here and
 *   must not replace this browser's own backdrop (`withLocalPicture`);
 * - a picture is deleted once the setting stops using it, whatever changed it (`releaseReplacedPictures`). Only
 *   transitions are acted on, never "everything but the current one", so a picture another tab just stored is safe.
 */
import { kvDelete } from '../lib/idb';
import type { Settings } from './schema';

type HomeBackground = Settings['appearance']['homeBackground'];

/** The kv key of a stored picture (`idb:<key>`), or null for colors, gradients and https images. */
export function storedPictureKey(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('idb:') && value.length > 4 ? value.slice(4) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns `doc` (an incoming, not yet validated settings document) with this browser's home background when the
 * incoming one is a picture stored in another browser. Anything else is returned unchanged.
 */
export function withLocalPicture<T>(doc: T, device: HomeBackground): T {
  if (!isRecord(doc) || !isRecord(doc.appearance) || !isRecord(doc.appearance.homeBackground)) return doc;
  const incoming = doc.appearance.homeBackground.value;
  if (!storedPictureKey(incoming) || incoming === device.value) return doc;
  return { ...doc, appearance: { ...doc.appearance, homeBackground: { ...device } } } as T;
}

/** Deletes stored pictures the home background no longer uses. Returns an unsubscribe function. */
export function releaseReplacedPictures(store: {
  readonly value: Settings;
  onChange(fn: (change: { sections: readonly string[] }) => void): () => void;
}): () => void {
  let current = storedPictureKey(store.value.appearance.homeBackground.value);
  return store.onChange((change) => {
    if (!change.sections.includes('appearance')) return;
    const next = storedPictureKey(store.value.appearance.homeBackground.value);
    if (current && current !== next) void kvDelete(current).catch(() => undefined);
    current = next;
  });
}
