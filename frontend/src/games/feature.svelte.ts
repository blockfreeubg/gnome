/**
 * `registerFeature('games')` while `/api/config` → `features.games` is true, unregistered when it turns false
 * (docs/WAVE-C.md §5.1, D20). Settings → Games shows its rows only while the feature is registered.
 */
import { server } from '../app/server.svelte';
import { registerFeature } from '../settings/features';

/** Registers or unregisters 'games' to follow `set(on)`; idempotent. */
export function gamesFeatureSwitch(): { set(on: boolean): void } {
  let off: (() => void) | null = null;
  return {
    set(on) {
      if (on && !off) off = registerFeature('games');
      else if (!on && off) {
        off();
        off = null;
      }
    },
  };
}

/** Follows the server's configuration for the lifetime of the app page. */
export function watchGamesFeature(): () => void {
  const sw = gamesFeatureSwitch();
  return $effect.root(() => {
    $effect(() => sw.set(server.config?.features.games === true));
  });
}
