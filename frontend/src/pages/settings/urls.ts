/** Parsers for URL-like settings inputs (shared by several sections). */
import { normalizeLinkUrl } from '../../lib/url';
import { isWispServer } from '../../shared/engine-protocol';
import { isSearchTemplate } from '../../settings/validate';

/** gnome:// pages or http(s) addresses (bare hosts become https://). */
export function parseStartUrl(raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (/^gnome:\/\/[a-z0-9/_-]*$/i.test(v)) return { value: v.toLowerCase() };
  const href = normalizeLinkUrl(v);
  if (!href || href.length > 4096) return { error: 'Enter a web address such as example.com, or a gnome:// page.' };
  return { value: href };
}

/**
 * Custom Wisp servers: a ws:// or wss:// address without credentials, or a path on the proxy origin (`/wisp/alt/`);
 * exactly what the engine protocol accepts in `route.custom.servers` (isWispServer).
 */
export function parseWispServer(raw: string): { value: string } | { error: string } {
  const v = raw.trim();
  if (v.startsWith('/')) return isWispServer(v) ? { value: v } : { error: 'Use a path such as /wisp/other/ (no "..", spaces or query).' };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { error: 'Use a ws:// or wss:// address, e.g. wss://wisp.example.com/.' };
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return { error: 'Use a ws:// or wss:// address.' };
  if (u.username || u.password) return { error: 'Leave credentials out of the address.' };
  if (!isWispServer(u.href)) return { error: 'The address is too long.' };
  return { value: u.href };
}

export function searchTemplateError(v: string): string | null {
  if (!v.trim()) return 'Enter an address with %s where the search terms go.';
  return isSearchTemplate(v.trim()) ? null : 'Use an http(s) address that contains %s, e.g. https://search.example/?q=%s.';
}
