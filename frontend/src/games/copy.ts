/** Texts of the Games pages that depend on data (docs/WAVE-C.md §5.1, §5.3, D24), kept pure for the unit tests. */
import { SOURCE_NAMES } from './player';
import type { GameFlag, GameSummary, GamesStatus, NetworkId, SourceId } from './types';

const LINK_OUT: ReadonlySet<SourceId> = new Set<SourceId>(['itchio', 'js13k']);

/** "a", "a and b", "a, b and c". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** The header line: "<playable> games to play here from <network names>" (+ " · <n> more on other sites"). */
export function statusLine(status: GamesStatus): string {
  const names = status.sources.filter((s) => !LINK_OUT.has(s.id)).map((s) => s.name);
  let line = `${plural(status.playable, 'game', 'games')} to play here`;
  if (names.length) line += ` from ${listJoin(names)}`;
  const more = status.listed - status.playable;
  if (more > 0) line += ` · ${more.toLocaleString('en-US')} more on other sites`;
  return line;
}

/** Why the catalog is empty (`status.listed` 0). */
export function emptyReason(status: GamesStatus | null): string {
  if (!status) return 'The catalog could not be read.';
  if (status.importing) return 'The first import is running.';
  const failed = status.sources.find((s) => s.last_import && s.last_import.status !== 'complete');
  if (failed) return `The last import from ${failed.name} failed; the server retries on its own.`;
  return 'The first import starts within a minute of the server starting.';
}

/** The count status: "<n> games" (or "<n> results" while searching or filtering). */
export function countText(total: number, results: boolean): string {
  return results ? plural(total, 'result', 'results') : plural(total, 'game', 'games');
}

export const FLAG_WORDS: Readonly<Record<GameFlag, string>> = {
  kids_friendly: 'Kids friendly',
  no_blood: 'No blood',
  no_cruelty: 'No cruelty',
  iap: 'In-app purchases',
  paid: 'Paid',
};

export function sourceName(source: SourceId): string {
  return SOURCE_NAMES[source];
}

/** "via GamePix". */
export function viaLine(game: Pick<GameSummary, 'source'>): string {
  return `via ${sourceName(game.source)}`;
}

/** Link-out games: the badge and the end of their link's name. */
export function linkOutBadge(game: Pick<GameSummary, 'source' | 'playable'>): string | null {
  if (game.playable) return null;
  return game.source === 'js13k' ? 'Opens on js13kGames' : game.source === 'itchio' ? 'Opens on itch.io' : 'Opens on another site';
}

/** The accessible name of a tile's link (§3.3: link-out tiles end with "(opens on itch.io)"). */
export function tileName(game: Pick<GameSummary, 'title' | 'source' | 'playable'>): string {
  const badge = linkOutBadge(game);
  return badge ? `${game.title} (${badge.charAt(0).toLowerCase()}${badge.slice(1)})` : game.title;
}

/** D24's notice on the stage. */
export function noticeText(network: NetworkId): string {
  const name = sourceName(network);
  return `This game loads from ${name}. ${name} and its advertisers see your IP address and may set cookies. GNOME's VPN and content blockers do not apply to games.`;
}

/** The note under the stage (§5.3, D13). */
export function playerNote(game: Pick<GameSummary, 'source'>): string {
  return game.source === 'oss' ? 'Served by this GNOME server.' : `Loaded directly from ${sourceName(game.source)}. Not routed through GNOME or its VPN.`;
}

export const PLAYER_NOTE_DETAIL =
  "The publisher and its advertisers see your IP address and may set cookies. GNOME's VPN and content blockers do not apply to games. Playing tells the game network this server's address.";

export function allowedNetworksLine(ids: readonly NetworkId[]): string {
  return `Game networks you allowed: ${listJoin(ids.map(sourceName))}`;
}

export const ORIENTATION_WORDS: Readonly<Record<'landscape' | 'portrait' | 'any', string>> = {
  landscape: 'Landscape',
  portrait: 'Portrait',
  any: 'Any orientation',
};
