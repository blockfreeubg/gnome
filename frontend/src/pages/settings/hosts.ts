/** Host input helpers for the site-rule editors. */
import { isHostKey } from '../../settings/validate';

/**
 * Turns what people paste ("https://www.Example.com/path", "example.com:8080", "*.example.com") into a host key, or
 * null when it is not a host name.
 */
export function normalizeHostInput(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  const wildcard = v.startsWith('*.');
  if (wildcard) v = v.slice(2);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      v = u.host;
    } catch {
      return null;
    }
  } else {
    v = v.split(/[/?#]/)[0] ?? '';
  }
  v = v.replace(/\.$/, '');
  const host = wildcard ? `*.${v}` : v;
  return host && isHostKey(host) && /[a-z0-9]/.test(v) ? host : null;
}

export function sortHosts(hosts: Iterable<string>): string[] {
  const key = (h: string): string => h.replace(/^\*\./, '').split('.').reverse().join('.');
  return [...hosts].sort((a, b) => key(a).localeCompare(key(b)) || a.localeCompare(b));
}

const IP_HOST_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?::\d+)?$/;

/**
 * The key a content-blocker site-rule editor stores for what was typed (WAVE-B3 §7.1, §9): a bare host becomes
 * `*.<host>` (`example.com` → `*.example.com`, which also covers `www.example.com`), unless the user chose "only this
 * host"; a wildcard, a `host:port` key and an IP literal stay as they are (wildcards never apply to IP addresses).
 * Null when it is not a host name. The site-permission editor (step 2) keeps normalizeHostInput.
 */
export function siteRuleKeyFromInput(raw: string, onlyThisHost: boolean): string | null {
  const h = normalizeHostInput(raw);
  if (!h) return null;
  if (onlyThisHost || h.startsWith('*.') || IP_HOST_RE.test(h) || /:\d+$/.test(h)) return h;
  const key = `*.${h}`;
  return isHostKey(key) ? key : h;
}
