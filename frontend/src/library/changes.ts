/**
 * Change notification for one library store: `onChange` listeners run (batched to one call per microtask burst)
 * after a write in this page, and after a write in another GNOME tab of this browser through the app-origin
 * BroadcastChannel `gnome:library` (so an open History page shows a visit another tab recorded).
 */

export type LibraryKind = 'history' | 'bookmarks' | 'downloads';

export const LIBRARY_CHANNEL = 'gnome:library';

interface ChannelLike {
  postMessage(msg: unknown): void;
  close(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface ChangeHub {
  onChange(listener: () => void): () => void;
  /** A write in this page: notify local listeners and other tabs. */
  emit(): void;
  close(): void;
}

let channel: ChannelLike | null = null;
let channelUsers = 0;
const hubs = new Map<LibraryKind, Set<() => void>>();

function openChannel(): void {
  channelUsers++;
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel(LIBRARY_CHANNEL) as unknown as ChannelLike;
  } catch {
    channel = null;
    return;
  }
  channel.onmessage = (ev) => {
    const kind = (ev.data as { kind?: unknown } | null)?.kind;
    if (kind !== 'history' && kind !== 'bookmarks' && kind !== 'downloads') return;
    for (const fire of hubs.get(kind) ?? []) fire();
  };
}

function closeChannel(): void {
  channelUsers = Math.max(0, channelUsers - 1);
  if (channelUsers === 0 && channel) {
    channel.close();
    channel = null;
  }
}

export function createChangeHub(kind: LibraryKind, opts: { crossTab?: boolean } = {}): ChangeHub {
  const crossTab = opts.crossTab ?? true;
  const listeners = new Set<() => void>();
  let scheduled = false;
  const fire = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (err) {
          console.error('[gnome] library listener failed', err);
        }
      }
    });
  };
  if (crossTab) {
    openChannel();
    let set = hubs.get(kind);
    if (!set) hubs.set(kind, (set = new Set()));
    set.add(fire);
  }
  let closed = false;
  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      fire();
      if (crossTab) channel?.postMessage({ kind });
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      if (crossTab) {
        hubs.get(kind)?.delete(fire);
        closeChannel();
      }
    },
  };
}
