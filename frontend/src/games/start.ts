/**
 * Games start-up (main.ts, on idle; docs/WAVE-C.md §3.2, §5.1): the "Recently played games" clearer (replacing the
 * built-in one so the open Games page updates too), the "Game network choices" clearer (D24), and — last, D20 — the
 * `games` feature while the server offers a catalog.
 */
import { registerClearer } from '../settings/clearers';
import { watchGamesFeature } from './feature.svelte';
import { gameLibrary } from './library.svelte';
import { forgetNetworks } from './networks';

let started = false;

export function startGames(): void {
  if (started) return;
  started = true;
  registerClearer({
    id: 'gamesRecent',
    label: 'Recently played games',
    description: 'The recently played list on the Games page.',
    order: 60,
    supportsTimeRange: true,
    clear: ({ since }) => gameLibrary().clearRecent(since),
  });
  registerClearer({
    id: 'gamesNetworks',
    label: 'Game network choices',
    description: 'Which game networks you allowed to load; the notice shows again before their next game.',
    order: 61,
    supportsTimeRange: false,
    clear: () => forgetNetworks(),
  });
  watchGamesFeature();
}
