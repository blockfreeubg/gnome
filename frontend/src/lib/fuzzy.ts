/**
 * Fuzzy matching for the command palette (pure; unit-tested). Case-insensitive subsequence match scored for
 * contiguous runs, word starts ("tsb" → "Toggle SideBar"), early matches and short targets.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices of matched characters in the target (for highlighting). */
  indices: number[];
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1] ?? '';
  const ch = text[i] ?? '';
  if (/[\s\-_./:·]/.test(prev)) return true;
  return prev === prev.toLowerCase() && ch !== ch.toLowerCase(); // camelCase hump
}

function scoreIndices(text: string, indices: number[]): number {
  let score = 0;
  let streak = 0;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    score += 1;
    if (isBoundary(text, i)) score += 8;
    if (k > 0 && i === indices[k - 1]! + 1) {
      streak++;
      score += 4 + streak;
    } else {
      streak = 0;
      if (k > 0) score -= Math.min(3, i - indices[k - 1]! - 1) * 0.5;
    }
  }
  if (indices[0] === 0) score += 6;
  score -= Math.min(10, text.length / 12);
  return score;
}

/** Greedy pass; `preferBoundaries` first tries to land each character on a word start. */
function greedy(text: string, lower: string, q: string, preferBoundaries: boolean): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const ch of q) {
    let found = -1;
    if (preferBoundaries) {
      for (let i = from; i < lower.length; i++) {
        if (lower[i] === ch && isBoundary(text, i)) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) found = lower.indexOf(ch, from);
    if (found < 0) return null;
    indices.push(found);
    from = found + 1;
  }
  return indices;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return { score: 0, indices: [] };
  const lower = text.toLowerCase();

  const candidates: number[][] = [];
  const sub = lower.indexOf(q);
  if (sub >= 0) {
    // Prefer an occurrence at a word start.
    let best = sub;
    for (let i = sub; i >= 0 && i < lower.length; i = lower.indexOf(q, i + 1)) {
      if (isBoundary(text, i)) {
        best = i;
        break;
      }
    }
    candidates.push(Array.from({ length: q.length }, (_, k) => best + k));
  }
  const compact = q.replace(/ /g, '');
  const a = greedy(text, lower, compact, true);
  if (a) candidates.push(a);
  const b = greedy(text, lower, compact, false);
  if (b) candidates.push(b);
  if (candidates.length === 0) return null;

  let bestMatch: FuzzyMatch | null = null;
  for (const indices of candidates) {
    const score = scoreIndices(text, indices) + (indices === candidates[0] && sub >= 0 ? 12 : 0);
    if (!bestMatch || score > bestMatch.score) bestMatch = { score, indices };
  }
  return bestMatch;
}

/** Splits text into highlighted / plain parts for rendering. */
export function highlightParts(text: string, indices: readonly number[]): Array<{ text: string; match: boolean }> {
  const set = new Set(indices);
  const parts: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.match === match) last.text += text[i];
    else parts.push({ text: text[i] ?? '', match });
  }
  return parts;
}
