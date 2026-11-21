/**
 * GNOME's notion of a site (WAVE-B3 §3.2): the only importer of `tldts-experimental` outside the libraries. Pure,
 * DOM-free. The app may import it lazily (the shield's site key, the cookie manager's grouping).
 */
import { getDomain } from 'tldts-experimental';

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/**
 * GNOME's notion of a site, like browsers': the Public Suffix List including its private section, so `foo.github.io`
 * and `bar.github.io` are different sites (tldts' default would merge them under `github.io`, and "pause on this site"
 * would then pause every GitHub Pages site).
 */
const SITE_OPTIONS = { allowPrivateDomains: true } as const;

/** Registrable domain of an http(s) URL's host (IP literals and hosts without one: the host itself); else null. */
export function siteOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (host.startsWith('[') || IPV4_RE.test(host)) return host;
  return getDomain(host, SITE_OPTIONS) ?? host;
}

/**
 * The `domain` Ghostery's own matching expects for a hostname (tldts defaults, without the private section, as
 * Ghostery's Request.fromRawDetails computes it): only for x1's getCosmeticsFilters/matchCosmeticFilters calls.
 */
export function listDomainOf(hostname: string): string {
  return getDomain(hostname) ?? hostname;
}

/** Whether `url` is third-party to the tab's top-level page (another registrable domain); null when unknown. */
export function isThirdParty(url: string, topLevelUrl: string | null): boolean | null {
  if (topLevelUrl === null) return null;
  const a = siteOf(url);
  const b = siteOf(topLevelUrl);
  return a === null || b === null ? null : a !== b;
}

/** The host key "pause on this site" writes (D3): `*.<registrable domain>`, or the bare host for IP literals. */
export function siteKeyOf(url: string): string | null {
  const s = siteOf(url);
  if (s === null) return null;
  return s.startsWith('[') || IPV4_RE.test(s) ? s : `*.${s}`;
}
