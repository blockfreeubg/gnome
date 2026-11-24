import { describe, expect, it } from 'vitest';
import { allowedNetworksLine, countText, emptyReason, noticeText, playerNote, statusLine, tileName } from './copy';
import type { GamesStatus } from './types';

const status = (over: Partial<GamesStatus> = {}): GamesStatus => ({
  listed: 0,
  playable: 0,
  importing: false,
  sources: [{ id: 'gamepix', name: 'GamePix', last_import: null }],
  ...over,
});

describe('games copy', () => {
  it('the header line names the networks and the link-out games', () => {
    const s = status({
      listed: 1300,
      playable: 1250,
      sources: [
        { id: 'gamepix', name: 'GamePix', last_import: null },
        { id: 'oss', name: 'Open source', last_import: null },
        { id: 'itchio', name: 'itch.io', last_import: null },
      ],
    });
    expect(statusLine(s)).toBe('1,250 games to play here from GamePix and Open source · 50 more on other sites');
    expect(statusLine(status({ listed: 1, playable: 1 }))).toBe('1 game to play here from GamePix');
  });

  it('explains an empty catalog', () => {
    expect(emptyReason(status({ importing: true }))).toBe('The first import is running.');
    expect(emptyReason(status({ sources: [{ id: 'gamepix', name: 'GamePix', last_import: { status: 'failed', finished_at: 1 } }] }))).toBe(
      'The last import from GamePix failed; the server retries on its own.',
    );
    expect(emptyReason(status())).toBe('The first import starts within a minute of the server starting.');
  });

  it('counts, names link-out tiles and writes the notices', () => {
    expect(countText(1, false)).toBe('1 game');
    expect(countText(2500, true)).toBe('2,500 results');
    expect(tileName({ title: 'Season Shift', source: 'itchio', playable: false })).toBe('Season Shift (opens on itch.io)');
    expect(tileName({ title: 'X', source: 'js13k', playable: false })).toBe('X (opens on js13kGames)');
    expect(tileName({ title: 'X', source: 'gamepix', playable: true })).toBe('X');
    expect(noticeText('gamepix')).toBe(
      "This game loads from GamePix. GamePix and its advertisers see your IP address and may set cookies. GNOME's VPN and content blockers do not apply to games.",
    );
    expect(playerNote({ source: 'gamedistribution' })).toBe('Loaded directly from GameDistribution. Not routed through GNOME or its VPN.');
    expect(playerNote({ source: 'oss' })).toBe('Served by this GNOME server.');
    expect(allowedNetworksLine(['gamepix', 'playgama'])).toBe('Game networks you allowed: GamePix and Playgama');
  });
});
