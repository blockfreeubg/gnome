/**
 * The player's rules (docs/WAVE-C.md §5.3, D2, D24). The app page frames only GNOME's own wrapper document,
 * `/play-frame/<slug>` (same origin, rendered by gnome-server with a CSP whose `frame-src` names exactly this game's
 * embed origin); the wrapper holds the game's sandboxed frame. The app never frames an embed URL itself.
 */
import type { GameDetail, NetworkId, SourceId } from './types';

/** `allow` of the outer frame: the superset the wrapper may pass on (the wrapper narrows it per game, §4.5). */
export const OUTER_ALLOW = 'fullscreen; autoplay; gamepad; accelerometer; gyroscope';

export interface FrameAttributes {
  src: string; // `/play-frame/<slug>` (same origin; the slug encoded with encodeURIComponent)
  title: string; // "<game title> (game)"
  allow: string; // OUTER_ALLOW
  allowfullscreen: true;
}

/** null when the game must not be framed here (`playable` false, `embed_kind` 'link', `embed_allowed` false). */
export function frameAttributes(game: GameDetail): FrameAttributes | null {
  if (!game.playable || game.embed_kind === 'link' || !game.embed_allowed) return null;
  return { src: `/play-frame/${encodeURIComponent(game.slug)}`, title: `${game.title} (game)`, allow: OUTER_ALLOW, allowfullscreen: true };
}

const NETWORKS: ReadonlySet<SourceId> = new Set<NetworkId>(['gamepix', 'gamedistribution', 'playgama', 'gamemonetize', 'famobi']);

export function isNetworkId(v: unknown): v is NetworkId {
  return typeof v === 'string' && NETWORKS.has(v as SourceId);
}

/** The network whose notice (D24) this game needs; null for OSS games (and link-outs, which are never framed). */
export function noticeNetwork(game: GameDetail): NetworkId | null {
  return isNetworkId(game.source) ? game.source : null;
}

/** Display names of the sources ("via GamePix"). */
export const SOURCE_NAMES: Readonly<Record<SourceId, string>> = {
  gamepix: 'GamePix',
  gamedistribution: 'GameDistribution',
  playgama: 'Playgama',
  gamemonetize: 'GameMonetize',
  famobi: 'Famobi',
  itchio: 'itch.io',
  js13k: 'js13kGames',
  oss: 'Open source',
};

/** Aspect ratio of the stage: width/height when both are known, else 16:9 (landscape, any) or 9:16 (portrait). */
export function stageAspect(game: Pick<GameDetail, 'width' | 'height' | 'orientation'>): number {
  const { width, height } = game;
  if (width && height && width > 0 && height > 0) return width / height;
  return game.orientation === 'portrait' ? 9 / 16 : 16 / 9;
}
