/**
 * The game networks this browser allowed (D24): before the first frame of a network loads, the player shows a notice
 * and waits for **Play**. The choice is kept in the app origin's localStorage (`gnome:games:allowed-networks`, a JSON
 * array of NetworkIds), changed only by the notice's Play, the Games page's Forget and the `gamesNetworks` clearer.
 * Other app tabs follow over the BroadcastChannel `gnome:games` (`games/channel.ts`).
 */
import { emitGamesChange } from './channel';
import { isNetworkId } from './player';
import type { NetworkId } from './types';

export const NETWORKS_KEY = 'gnome:games:allowed-networks';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The allowed networks; a missing or corrupt stored value counts as none. */
export function allowedNetworks(): readonly NetworkId[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(NETWORKS_KEY) ?? null;
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? [...new Set(v.filter(isNetworkId))] : [];
  } catch {
    return [];
  }
}

function write(ids: readonly NetworkId[]): void {
  try {
    const s = storage();
    if (!s) return;
    if (ids.length) s.setItem(NETWORKS_KEY, JSON.stringify(ids));
    else s.removeItem(NETWORKS_KEY);
  } catch {
    // Storage full or blocked: the notice simply shows again next time.
  }
  emitGamesChange('networks');
}

export function allowNetwork(id: NetworkId): void {
  const current = allowedNetworks();
  if (current.includes(id)) return;
  write([...current, id]);
}

export function forgetNetworks(): void {
  write([]);
}
