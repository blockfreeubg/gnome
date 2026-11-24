import type { GameDetail, GameSummary } from './types';

/** The summary part of a detail (what favorites and recently played store as their snapshot). */
export function summaryOf(g: GameDetail): GameSummary {
  const { id, slug, title, developer, thumbnail, categories, mobile, source, added_at, plays, playable } = g;
  return { id, slug, title, developer, thumbnail, categories: [...categories], mobile, source, added_at, plays, playable };
}
