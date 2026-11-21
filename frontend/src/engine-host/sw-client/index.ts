/**
 * The engine host's service-worker client (WAVE-B §3, lane b). Lane a's `main.ts` passes `createSwClient` to
 * `startEngineHost()`; the core calls `ensureControlled()` at `init`, before any engine exists.
 */

import type { SwClient } from '../../shared/proxy-origin';
import { GnomeSwClient } from './client';

export function createSwClient(): SwClient {
  return new GnomeSwClient({
    container: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    secureContext: window.isSecureContext,
    origin: location.origin,
    build: __GNOME_BUILD__,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  });
}

export { GnomeSwClient, SW_TIMEOUTS } from './client';
