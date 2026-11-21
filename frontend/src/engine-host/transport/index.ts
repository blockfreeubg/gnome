/**
 * The engine host's transport manager (WAVE-B §3, lane b). Lane a's `main.ts` passes `createTransportManager` to
 * `startEngineHost()`. Call it once, early: it wraps this realm's WebSocket before any transport module loads, so the
 * watchdog sees the Scramjet-side Wisp sockets.
 */

import type { TransportManager } from '../../shared/transport';
import { GnomeTransportManager } from './manager';
import { bareMuxUvBackend, windowProbe, windowScramjetBackend, windowTestSocket } from './window-backends';

export function createTransportManager(): TransportManager {
  const win = window;
  return new GnomeTransportManager({
    scramjet: windowScramjetBackend(win),
    uv: () => bareMuxUvBackend(win),
    probe: windowProbe(win),
    now: () => Date.now(),
    random: () => Math.random(),
    setTimeout: (fn, ms) => win.setTimeout(fn, Math.min(Math.max(0, ms), 2 ** 31 - 1)),
    clearTimeout: (h) => win.clearTimeout(h as number),
    log: (level, message) => {
      if (level === 'debug') return;
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`[gnome transport] ${message}`);
    },
    testSocket: windowTestSocket(win),
  });
}

export { GnomeTransportManager } from './manager';
