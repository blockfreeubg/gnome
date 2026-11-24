import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { listClearers, runClearers } from '../settings/clearers';
import { isFeatureActive } from '../settings/features';
import { gamesFeatureSwitch } from './feature.svelte';
import { allowedNetworks, allowNetwork } from './networks';
import { startGames } from './start';

describe('startGames', () => {
  it('registers both clearers once; the networks clearer forgets the choices', async () => {
    startGames();
    startGames();
    const ids = listClearers().map((c) => c.id);
    expect(ids.filter((id) => id === 'gamesRecent')).toHaveLength(1);
    expect(ids).toContain('gamesNetworks');
    allowNetwork('gamepix');
    await runClearers(['gamesNetworks']);
    expect(allowedNetworks()).toEqual([]);
  });

  it('registers the games feature only while the server offers a catalog', () => {
    const sw = gamesFeatureSwitch();
    sw.set(false);
    expect(isFeatureActive('games')).toBe(false);
    sw.set(true);
    sw.set(true);
    expect(isFeatureActive('games')).toBe(true);
    sw.set(false);
    expect(isFeatureActive('games')).toBe(false);
  });
});
