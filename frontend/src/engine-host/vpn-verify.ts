/**
 * The VPN exit check (capability `vpnVerify`, ENGINE-PROTOCOL §6.13): the check service URL the app took from
 * `/api/vpn/locations` → `verify_url` (am.i.mullvad.net/json by default), fetched through the current route with
 * TransportManager.proxyFetch, reduced to `{ip, country, city, vpnExit, checkedAt}`.
 *
 * The answer is what the check service says, never proof: after an escape a page can forge all of it (the app takes
 * "VPN active" from its own facts). The parser accepts am.i.mullvad.net's JSON (`ip`, `country`, `city`,
 * `mullvad_exit_ip`) and the common `ip`/`country`/`city` shape of other services, and nothing else.
 */
import { fitText, sanitizeText } from '../shared/engine-protocol';
import type { VpnVerifyResult } from '../shared/engine-protocol';
import type { ProxyFetchInit, ProxyFetchResult } from '../shared/transport';

export const VPN_VERIFY_FETCH: ProxyFetchInit = { method: 'GET', headers: { accept: 'application/json' }, timeoutMs: 15000, maxBytes: 16 * 1024 };

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** A literal IPv4 or IPv6 address (no zone, no brackets), or null. */
export function ipLiteral(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (IPV4.test(s)) return s;
  if (s.length < 2 || s.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(s) || !s.includes(':')) return null;
  try {
    // The URL parser canonicalizes valid IPv6 literals and rejects everything else.
    new URL(`http://[${s}]/`);
    return s.toLowerCase();
  } catch {
    return null;
  }
}

const place = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = fitText(sanitizeText(v).trim(), max);
  return s ? s : null;
};

export function parseVpnVerify(body: string, now: number): VpnVerifyResult {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('the check service answered something that is not JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('the check service answered an unknown format');
  const d = data as Record<string, unknown>;
  const ip = ipLiteral(d.ip);
  if (!ip) throw new Error('the check service did not report an IP address');
  return {
    ip,
    country: place(d.country, 64),
    city: place(d.city, 128),
    vpnExit: typeof d.mullvad_exit_ip === 'boolean' ? d.mullvad_exit_ip : null,
    checkedAt: Math.floor(now),
  };
}

export async function vpnVerify(
  proxyFetch: (url: string, init: ProxyFetchInit) => Promise<ProxyFetchResult>,
  url: string,
  now: () => number = Date.now,
): Promise<VpnVerifyResult> {
  const r = await proxyFetch(url, VPN_VERIFY_FETCH);
  if (r.status < 200 || r.status >= 300) throw new Error(`the check service answered ${r.status}`);
  return parseVpnVerify(new TextDecoder('utf-8').decode(r.body), now());
}
