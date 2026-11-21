/**
 * The window-side hook registry for Wave B step 3 (content blocking; WAVE-B §9, engine-hooks.ts). Until something
 * registers, every call site gets ALLOW_ALL, which blocks nothing and reports the blocker as `off`. The engine-host
 * core calls these hooks from Scramjet's per-tab plugin (`fetch.request` → onRequest through safeVerdict,
 * `fetch.preresponse` → onResponse, `init.post` → onDocument), from the UV document point (onDocument, after UV's
 * client hooked the window) and from the wrapper of `Ultraviolet.BareClient.prototype.createWebSocket` in each UV
 * document (onWebSocket).
 *
 * Registrations form a stack (WAVE-B3 §4.4): unregistering restores whatever was current before, not ALLOW_ALL, so
 * the e2e-only `test.hooks` (and its `{}` form) puts the content blocker back.
 */
import { ALLOW_ALL } from '../shared/engine-hooks';
import type { EngineHooks } from '../shared/engine-hooks';

const stack: EngineHooks[] = [];
const listeners = new Set<(hooks: EngineHooks) => void>();

const top = (): EngineHooks => stack[stack.length - 1] ?? ALLOW_ALL;

/** Registers hooks on top; the returned function removes exactly them (the hooks below come back into force). */
export function registerEngineHooks(hooks: EngineHooks): () => void {
  const entry = hooks;
  stack.push(entry);
  for (const l of listeners) l(entry);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const before = top();
    const i = stack.lastIndexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    const now = top();
    if (now !== before) for (const l of listeners) l(now);
  };
}

/** The hooks in force (ALLOW_ALL until something registered). */
export function engineHooks(): EngineHooks {
  return top();
}

/** The core re-applies settings and re-reports the blocker status when the hooks change. */
export function onEngineHooksChange(listener: (hooks: EngineHooks) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
