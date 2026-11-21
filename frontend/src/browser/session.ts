/**
 * Session persistence and "fresh start" detection for the browser (docs/WAVE-B.md §4).
 *
 * - The tab session (real URLs and back/forward entries, never proxied URLs) is kept in IndexedDB `session` under
 *   `tabs`, written a moment after every change.
 * - A **fresh start** is the first app page of a browsing session: this browser tab has no sessionStorage marker yet
 *   (a reload keeps it) and no other GNOME tab answers on the app-origin BroadcastChannel `gnome-app` within a short
 *   wait. Only then do "clear … when GNOME closes" settings apply (work during page unload does not finish
 *   reliably, ENGINE-PROTOCOL §6.11), and only then does `browser.startup` decide what opens; a reload restores the
 *   tabs it had.
 */
import { idbGet, idbPut } from '../lib/idb';

const MARKER = 'gnome:app-page:v1';
const CHANNEL = 'gnome-app';
const SESSION_KEY = 'tabs';

export interface StartKind {
  /** No marker in this browser tab: GNOME was not open here before (a new tab, or the browser restarted). */
  firstInTab: boolean;
  /** Another GNOME page answered (another browser tab of this origin is open). */
  othersOpen: boolean;
}

let started: Promise<StartKind> | null = null;
let channel: BroadcastChannel | null = null;

/**
 * Detects how this app page started (memoized) and starts answering other GNOME pages' pings. The channel is on the
 * app origin, which proxied pages cannot reach (they run on the proxy origin).
 */
export function detectStart(waitMs = 250): Promise<StartKind> {
  started ??= new Promise<StartKind>((resolve) => {
    let firstInTab = true;
    try {
      firstInTab = sessionStorage.getItem(MARKER) === null;
      sessionStorage.setItem(MARKER, '1');
    } catch {
      firstInTab = false; // unknown: never clear data on a guess
    }
    if (typeof BroadcastChannel === 'undefined') {
      resolve({ firstInTab, othersOpen: !firstInTab });
      return;
    }
    const id = Math.random().toString(36).slice(2);
    channel = new BroadcastChannel(CHANNEL);
    let othersOpen = false;
    channel.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; id?: string } | null;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'ping' && d.id !== id) channel?.postMessage({ type: 'pong', to: d.id, from: id });
      else if (d.type === 'pong' && (d as { to?: string }).to === id) othersOpen = true;
      else if (d.type === 'pong') for (const fn of pongListeners) fn(d as { to?: string; from?: string });
    };
    channel.postMessage({ type: 'ping', id });
    setTimeout(() => resolve({ firstInTab, othersOpen }), waitMs);
  });
  return started;
}

const pongListeners = new Set<(d: { to?: string; from?: string }) => void>();

/** How many other GNOME pages (browser tabs of the app origin) answer right now. */
export async function otherAppPages(waitMs = 600): Promise<number> {
  await detectStart();
  const ch = channel;
  if (!ch) return 0;
  const id = Math.random().toString(36).slice(2);
  const seen = new Set<string>();
  const fn = (d: { to?: string; from?: string }): void => {
    if (d.to === id && d.from) seen.add(d.from);
  };
  pongListeners.add(fn);
  ch.postMessage({ type: 'ping', id });
  await new Promise((r) => setTimeout(r, waitMs));
  pongListeners.delete(fn);
  return seen.size;
}

/** Stops answering other GNOME pages (tests, hot reload). */
export function closeSessionChannel(): void {
  channel?.close();
  channel = null;
}

/** Whether "clear on exit" applies now: a fresh start with no other GNOME page open. */
export function isFreshStart(k: StartKind): boolean {
  return k.firstInTab && !k.othersOpen;
}

export async function loadSession(): Promise<unknown> {
  try {
    return await idbGet('session', SESSION_KEY);
  } catch {
    return undefined;
  }
}

export async function saveSession(snapshot: unknown): Promise<void> {
  try {
    await idbPut('session', snapshot, SESSION_KEY);
  } catch {
    // Storage unavailable: the session is not kept (the status registry already reports storage problems).
  }
}
