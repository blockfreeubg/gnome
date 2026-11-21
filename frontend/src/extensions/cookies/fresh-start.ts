/**
 * Cookie rules "until GNOME closes" (`session`, WAVE-B3 D4, §6.1): the cookie provider makes such a site's cookies
 * session cookies, and at the next fresh start (no other GNOME tab open, ENGINE-PROTOCOL §6.11) the app deletes the
 * site's cookies in both engines' jars, after `init` and before tabs are restored (x4 sends these commands).
 * `cookies.delete` works per site and subdomains, so a rule for `example.com` also ends the cookies of its
 * subdomains (the cookie-rule editor says so). App side, pure.
 */
import type { CommandPayload } from '../../shared/engine-protocol';
import type { Settings } from '../../settings/schema';

/** The `site` of `cookies.delete` for a rule's host key: without `*.` and port; an IPv6 key keeps its brackets. */
export function siteOfHostKey(key: string): string | null {
  let k = key.trim().toLowerCase();
  if (k.startsWith('*.')) k = k.slice(2);
  if (k.startsWith('[')) {
    const end = k.indexOf(']');
    if (end === -1) return null;
    k = k.slice(0, end + 1);
  } else {
    k = k.replace(/:\d{1,5}$/, '');
  }
  // The cookies.delete validator's site syntax (engine-protocol SITE_RE): a lower-case host name or IP literal.
  if (k === '' || k.length > 253) return null;
  if (!/^(?:(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?|\[[0-9a-f:.]+\])$/.test(k)) return null;
  return k;
}

/**
 * One `cookies.delete {all: false, site, name: null}` per `session` rule while the cookie manager is on, deduplicated
 * (`*.example.com` and `example.com:8080` both become `example.com`). Nothing while the cookie manager is off.
 */
export function freshStartCookieDeletes(ext: Settings['extensions']): Array<CommandPayload<'cookies.delete'>> {
  if (!ext.enabled.cookies) return [];
  const sites = new Set<string>();
  for (const [key, rule] of Object.entries(ext.cookieRules)) {
    if (rule !== 'session') continue;
    const site = siteOfHostKey(key);
    if (site !== null) sites.add(site);
  }
  return [...sites].sort().map((site) => ({ all: false, site, name: null }));
}
