/**
 * Request hooks of the service worker (Ultraviolet's `request` and `beforemod` events call them; WAVE-B §9). Wave B
 * step 3 registers the content blocker here, fed by `{type: 'gnome-blocker-config'}` from the engine-host client.
 * Until then ALLOW_ALL: nothing is blocked and the blocker reports `off`.
 */

import { ALLOW_ALL, type RequestHooks } from '../shared/engine-hooks';

let current: RequestHooks = ALLOW_ALL;

export function registerSwHooks(hooks: RequestHooks): void {
  current = hooks;
}

/** The hooks every call site uses (through safeVerdict: a throw allows the request). */
export function swHooks(): RequestHooks {
  return current;
}
