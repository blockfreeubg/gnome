/**
 * Change notification for the games data of this browser (favorites, recently played, allowed networks): listeners
 * in this page run after a local write, and other GNOME tabs hear it over the app-origin BroadcastChannel
 * `gnome:games` (§5.1).
 */
export const GAMES_CHANNEL = 'gnome:games';
export type GamesChange = 'favorites' | 'recent' | 'networks';

const CHANGES: ReadonlySet<string> = new Set<GamesChange>(['favorites', 'recent', 'networks']);

interface ChannelLike {
  postMessage(msg: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

const listeners = new Set<(kind: GamesChange, remote: boolean) => void>();
let channel: ChannelLike | null | undefined;

function open(): ChannelLike | null {
  if (channel !== undefined) return channel;
  channel = null;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    const ch = new BroadcastChannel(GAMES_CHANNEL) as unknown as ChannelLike;
    ch.onmessage = (ev) => {
      const kind = (ev.data as { kind?: unknown } | null)?.kind;
      if (typeof kind === 'string' && CHANGES.has(kind)) for (const fn of [...listeners]) fn(kind as GamesChange, true);
    };
    channel = ch;
  } catch {
    channel = null;
  }
  return channel;
}

/** A write in this page: tell local listeners and the other tabs. */
export function emitGamesChange(kind: GamesChange): void {
  for (const fn of [...listeners]) fn(kind, false);
  try {
    open()?.postMessage({ kind });
  } catch {
    // A closed channel: other tabs refresh on their next visit.
  }
}

/** Listens to changes from this page (`remote` false) and from other tabs (`remote` true). */
export function onGamesChange(fn: (kind: GamesChange, remote: boolean) => void): () => void {
  open();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests: drops the channel so the next use opens a fresh one. */
export function resetGamesChannel(): void {
  channel?.close();
  channel = undefined;
  listeners.clear();
}
