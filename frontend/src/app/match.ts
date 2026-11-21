/**
 * Route pattern matching (pure; unit-tested). Patterns: static segments, `:param` (one segment) and a trailing `*`
 * (rest of the path, available as params.wildcard). Matching ignores a trailing slash and is case-sensitive for
 * params but case-insensitive for static segments.
 */

export interface CompiledPattern {
  pattern: string;
  regex: RegExp;
  keys: string[];
  /** Higher = more specific (static > param > wildcard), used to order candidates. */
  score: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizePath(pathname: string): string {
  // "/index.html" is the app shell itself (servers also answer it as a file): it means the page at that directory.
  let p = pathname.replace(/\/{2,}/g, '/').replace(/\/index\.html$/i, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function compilePattern(pattern: string): CompiledPattern {
  const norm = normalizePath(pattern);
  const keys: string[] = [];
  let score = 0;
  if (norm === '/') return { pattern: norm, regex: /^\/?$/i, keys, score: 100 };
  const segments = norm.split('/').filter(Boolean);
  let source = '^';
  segments.forEach((seg, i) => {
    if (seg === '*' && i === segments.length - 1) {
      keys.push('wildcard');
      source += '(?:/(.*))?';
      score += 1;
    } else if (seg.startsWith(':')) {
      keys.push(seg.slice(1));
      source += '/([^/]+)';
      score += 20;
    } else {
      source += `/${escapeRe(seg)}`;
      score += 30;
    }
  });
  source += '/?$';
  return { pattern: norm, regex: new RegExp(source, 'i'), keys, score: score + segments.length };
}

/** Returns decoded params, or null when the path does not match (or contains malformed escapes). */
export function matchPattern(compiled: CompiledPattern, pathname: string): Record<string, string> | null {
  const m = compiled.regex.exec(normalizePath(pathname));
  if (!m) return null;
  const params: Record<string, string> = {};
  try {
    compiled.keys.forEach((key, i) => {
      const raw = m[i + 1];
      params[key] = raw === undefined ? '' : decodeURIComponent(raw);
    });
  } catch {
    return null;
  }
  return params;
}

/** Builds a path from a pattern and params (params are URI-encoded). */
export function buildPath(pattern: string, params: Record<string, string | number> = {}): string {
  const norm = normalizePath(pattern);
  const out = norm
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        const v = params[seg.slice(1)];
        if (v === undefined) throw new Error(`Missing route param "${seg.slice(1)}" for ${pattern}`);
        return encodeURIComponent(String(v));
      }
      if (seg === '*') return params.wildcard !== undefined ? String(params.wildcard) : '';
      return seg;
    })
    .join('/');
  return normalizePath(out || '/');
}

/**
 * Paths the server owns, never handled by the client router: the API, admin, static assets and — in single-origin
 * mode, where one origin also plays the proxy role (docs/ARCHITECTURE.md §4.6) — the engine host, its service
 * worker, vendor builds, Wisp and the engine prefixes (`/~/sj/*`, `/uv/service/*`). Anything with a file extension
 * is a file.
 */
export function isServerPath(pathname: string): boolean {
  return (
    /^\/(api|admin|wisp|engine|vendor|uv|assets|brand|~)(\/|$)/i.test(pathname) ||
    /^\/sw\.js$/i.test(pathname) ||
    /\.[a-z0-9]{1,12}$/i.test(pathname)
  );
}
