/** Games catalog wire shapes (docs/WAVE-C.md §3.2, the routes of §4.2). */
/** A GNOME category slug: the 14 core ones always, `shooter` `io` `card` `educational` `music` when used. */
export type CategorySlug = string;
export type SourceId = 'gamepix' | 'gamedistribution' | 'playgama' | 'gamemonetize' | 'famobi' | 'itchio' | 'js13k' | 'oss';
export type GameSort = 'relevance' | 'popular' | 'trending' | 'new' | 'featured' | 'az';
export type GameFlag = 'kids_friendly' | 'no_blood' | 'no_cruelty' | 'iap' | 'paid';

export interface GameSummary {
  id: number;
  slug: string;
  title: string; // plain text: render as text, never as HTML ("Press <Space>")
  developer: string | null;
  /** `/api/thumb/<id>`, a network image URL (thumbnail proxy off) or `<proxy origin>/oss/…`; null = none. */
  thumbnail: string | null;
  categories: CategorySlug[]; // primary first, at most 3
  mobile: boolean;
  source: SourceId;
  added_at: number; // ms
  plays: number;
  /** false = link-out only (itch.io, js13kGames): open source_url in a new tab, never frame it. */
  playable: boolean;
}

export interface GameDetail extends GameSummary {
  description: string;
  instructions: string;
  tags: string[];
  embed_url: string;
  width: number | null;
  height: number | null;
  source_url: string | null;
  developer_url: string | null;
  license: string | null; // SPDX, OSS only
  published_at: number | null;
  attribution: string; // "via GamePix", or "<SPDX> · <copyright>" for OSS
  embed_kind: 'iframe' | 'selfhost' | 'link';
  orientation: 'landscape' | 'portrait' | 'any' | null;
  flags: GameFlag[];
  /** This server frames the game (D4): `/play-frame/<slug>` answers 200. false: offer source_url instead. */
  embed_allowed: boolean;
  /** Self-hosted games only (`repository` is null for an operator's own `local` build, §4.8). */
  oss: { repository: string | null; commit: string | null; license_file_url: string | null } | null;
}

/** The game networks a frame can come from (D24's notice is per network); OSS games need none. */
export type NetworkId = Exclude<SourceId, 'itchio' | 'js13k' | 'oss'>;

export interface GamePage { game: GameDetail; related: GameSummary[] }
export interface GameListPage { items: GameSummary[]; next_cursor: string | null; total: number }
export interface GameSections { featured: GameSummary[]; trending: GameSummary[]; popular: GameSummary[]; new: GameSummary[] }
export interface GameCategory { slug: CategorySlug; name: string; count: number }
export interface GameTag { tag: string; count: number }
export interface GamesStatus {
  listed: number;
  /** Listed games that play here (embeds and OSS); `listed - playable` open on other sites (itch.io, js13kGames). */
  playable: number;
  importing: boolean;
  sources: Array<{
    id: SourceId;
    name: string; // display name: "GamePix", "Open source"
    last_import: { status: 'complete' | 'incomplete' | 'failed' | 'interrupted'; finished_at: number } | null;
  }>;
}

/** `GET /api/games` parameters (the UI never sends `cursor` with changed filters). */
export interface GameListQuery {
  q?: string;
  category?: CategorySlug;
  tag?: string;
  sort?: GameSort;
  mobile?: boolean;
  exclude?: CategorySlug[];
  include_link_out?: boolean;
  cursor?: string;
  limit?: number; // 1–100, the UI uses 48
}
