/**
 * GNOME's built-in table of tracking parameters (WAVE-B3 §6.1, D13): removed from the URLs of pages you open (tab
 * documents and frames, GET/HEAD) by the privacy provider, together with the `$removeparam` filters of the enabled
 * filter lists. It works before any filter list is compiled.
 *
 * The parameter names are derived from the `globalRules` of the ClearURLs rules (https://github.com/ClearURLs/Rules,
 * `data.min.json`, by Kevin Röbert and the ClearURLs contributors), which are licensed under the GNU Lesser General
 * Public License v3.0 (LGPL-3.0). Only these exact names (and every name that starts with `utm_`) are taken; ClearURLs'
 * broader patterns (`[a-z]?mc`, `ref_?`, `referrer`) are left out because they also match parameters sites need.
 *
 * Pure, DOM-free (the service worker compiles it too).
 */

/** Exact parameter names (case-sensitive, after percent-decoding the name). `utm_*` is matched by prefix in code. */
export const BUILTIN_TRACKING_PARAMS: readonly string[] = [
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'igsh',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  '__hssc',
  '__hstc',
  '__hsfp',
  'hsCtaTracking',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'rb_clickid',
  's_cid',
  'vero_conv',
  'vero_id',
  'wickedid',
  '_openstat',
  'srsltid',
];

const EXACT: ReadonlySet<string> = new Set(BUILTIN_TRACKING_PARAMS);
const UTM_PREFIX = 'utm_';

/** The decoded name of one `name=value` piece of a query (`+` is a space, as in form encoding); null if malformed. */
function pieceName(piece: string): string | null {
  const eq = piece.indexOf('=');
  const raw = (eq === -1 ? piece : piece.slice(0, eq)).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Whether a decoded parameter name is one of the built-in tracking parameters. */
export function isBuiltinTrackingParam(name: string): boolean {
  return EXACT.has(name) || (name.startsWith(UTM_PREFIX) && name.length > UTM_PREFIX.length);
}

/**
 * `url` without the built-in tracking parameters: the other parameters keep their order and their exact spelling,
 * the fragment stays, an empty query loses its `?`. Null when nothing changed (also for non-http(s) or invalid URLs).
 */
export function stripBuiltinParams(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.search.length <= 1) return null;
  const pieces = u.search.slice(1).split('&');
  const kept: string[] = [];
  let removed = false;
  for (const piece of pieces) {
    const name = piece === '' ? null : pieceName(piece);
    if (name !== null && isBuiltinTrackingParam(name)) removed = true;
    else kept.push(piece);
  }
  if (!removed) return null;
  // Empty pieces (`a=1&&b=2`) are kept as they were unless nothing else is left.
  const rest = kept.join('&');
  u.search = kept.every((p) => p === '') ? '' : `?${rest}`;
  return u.href;
}
