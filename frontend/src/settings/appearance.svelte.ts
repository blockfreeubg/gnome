/**
 * Reactive glue between the settings store and the DOM: re-applies appearance whenever settings, the OS color
 * scheme or the OS reduced-motion preference change. Also exposes the resolved theme/motion for components.
 */
import { MediaQuery } from 'svelte/reactivity';
import { applyAppearance, computeAppearance, resolveMotion, resolveTheme } from './apply';
import { settings } from './store.svelte';

let prefersLight: MediaQuery | null = null;
let prefersReduced: MediaQuery | null = null;

function queries(): { light: MediaQuery; reduced: MediaQuery } {
  prefersLight ??= new MediaQuery('prefers-color-scheme: light');
  prefersReduced ??= new MediaQuery('prefers-reduced-motion: reduce');
  return { light: prefersLight, reduced: prefersReduced };
}

/** Resolved, reactive appearance facts. */
export const appearance = {
  get theme(): 'dark' | 'light' {
    return resolveTheme(settings.value.appearance.theme, { prefersLight: queries().light.current });
  },
  get motion() {
    return resolveMotion(settings.value.appearance.animation, { prefersReducedMotion: queries().reduced.current });
  },
};

/** Starts applying settings to <html>. Returns a stop function. */
export function startAppearanceEngine(): () => void {
  const q = queries();
  return $effect.root(() => {
    const payload = $derived(computeAppearance(settings.value));
    $effect(() => {
      applyAppearance(payload, { prefersLight: q.light.current, prefersReducedMotion: q.reduced.current });
    });
  });
}
