/**
 * Foreign-cookie hygiene for two-origin mode (WAVE-D D19 (3)).
 *
 * With the proxy origin on a sibling hostname (gnome.example.com + p.gnome.example.com), a hostile proxied page can
 * plant cookies for a parent domain the app origin shares, until every request of the app carries hundreds of KB of
 * them. The server tolerates that (its head limits and budget are the guarantee); this module only keeps typical
 * heads small. In two-origin mode the app origin has no legitimate script-visible cookie (GNOME's own are HttpOnly,
 * and nothing in frontend/src sets one), so every cookie `document.cookie` shows is foreign and is expired:
 *
 * - host-only, and at every domain level from the app host down to the longest common parent of the app and proxy
 *   hostnames, except the registrable domain (for gnome.example.com + p.gnome.example.com: gnome.example.com; for two
 *   ports on localhost or an IP address: host-only only);
 * - at the registrable domain only when `document.cookie` exceeds 32 KB or the operator opted in
 *   (`/api/config` `proxy.cookieHygiene` = "registrable", GNOME_COOKIE_HYGIENE), because other sites of the operator
 *   legitimately set cookies there;
 * - at `Path=/`, with `Secure` on HTTPS pages and for `__Secure-`/`__Host-` names; at most 200 names per run.
 *
 * It cannot see cookies planted with another `Path` (they still reach /api/* requests) or HttpOnly ones. Without a
 * public-suffix list the registrable domain is estimated as the last two labels (three when the second-level label is
 * a common one such as `co` in `example.co.uk`); the estimate errs towards clearing less, never more.
 *
 * It runs only in two-origin mode (`/api/config` `proxy.isolated`): in single-origin mode the origin is shared with
 * the engines and the hygiene stays off.
 */

/** At most this many cookie names are expired per run. */
export const MAX_NAMES_PER_RUN = 200;
/** Above this `document.cookie` length the registrable-domain level is cleared too. */
export const REGISTRABLE_THRESHOLD = 32 * 1024;
/** How often the hygiene runs while the app is open (also at start and when the page becomes visible). */
export const HYGIENE_INTERVAL_MS = 5 * 60_000;

/** Second-level labels under which registrable domains have three labels (example.co.uk, example.com.au). */
const SHORT_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'gv', 'ltd', 'plc']);

export interface CookieJarLike {
  cookie: string;
}

export interface HygieneOptions {
  /** The app origin's hostname (no port). */
  appHost: string;
  /** The proxy origin's hostname (no port). */
  proxyHost: string;
  /** The operator's opt-in to clear the registrable-domain level too. */
  registrable: boolean;
  /** The page is HTTPS (Secure deletions). */
  https: boolean;
}

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

/** The estimated registrable domain of `host` (null for IP addresses and single-label hosts such as localhost). */
export function registrableDomain(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIp(h)) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  const n = labels.length >= 3 && SHORT_SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-n).join('.');
}

/** The domain levels expired besides host-only: app host down to the common parent, without/with the registrable one. */
export function hygieneLevels(appHost: string, proxyHost: string, withRegistrable: boolean): string[] {
  const app = appHost.toLowerCase().replace(/\.$/, '');
  const proxy = proxyHost.toLowerCase().replace(/\.$/, '');
  const reg = registrableDomain(app);
  if (!reg || isIp(app) || isIp(proxy) || registrableDomain(proxy) !== reg) return [];
  const a = app.split('.');
  const p = proxy.split('.');
  let common = 0;
  while (common < a.length && common < p.length && a[a.length - 1 - common] === p[p.length - 1 - common]) common++;
  const regLabels = reg.split('.').length;
  const levels: string[] = [];
  // From the app host down to the longest common parent, never past the registrable domain.
  for (let n = a.length; n >= Math.max(common, regLabels + 1); n--) levels.push(a.slice(-n).join('.'));
  if (withRegistrable) levels.push(reg);
  return levels;
}

/** Cookie names `document.cookie` shows (deduplicated, at most MAX_NAMES_PER_RUN). */
export function cookieNames(cookie: string): string[] {
  const names = new Set<string>();
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).trim();
    if (name) names.add(name);
    if (names.size >= MAX_NAMES_PER_RUN) break;
  }
  return [...names];
}

/** Expires every foreign cookie the page can see; returns the names it expired. */
export function cleanForeignCookies(jar: CookieJarLike, opts: HygieneOptions): string[] {
  const before = jar.cookie;
  if (!before) return [];
  const names = cookieNames(before);
  const levels = hygieneLevels(opts.appHost, opts.proxyHost, opts.registrable || before.length > REGISTRABLE_THRESHOLD);
  const expire = 'Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/';
  for (const name of names) {
    const secure = opts.https || name.startsWith('__Secure-') || name.startsWith('__Host-') ? '; Secure' : '';
    jar.cookie = `${name}=; ${expire}${secure}`;
    if (name.startsWith('__Host-')) continue; // never carries a Domain
    for (const level of levels) jar.cookie = `${name}=; ${expire}; Domain=${level}${secure}`;
  }
  return names;
}

/** What the hygiene needs from the server configuration (app/server.svelte.ts `server`). */
export interface HygieneConfigSource {
  config: { proxy?: { origin: string | null; isolated: boolean; cookieHygiene?: string } } | null;
}

/**
 * Runs the hygiene at start (once the configuration is known), every HYGIENE_INTERVAL_MS and when the page becomes
 * visible; only in two-origin mode. Returns a stop function.
 */
export function startCookieHygiene(source: HygieneConfigSource, win: Window & typeof globalThis = window): () => void {
  const run = (): boolean => {
    const proxy = source.config?.proxy;
    if (!proxy) return false;
    if (!proxy.isolated || !proxy.origin) return true;
    let proxyHost: string;
    try {
      proxyHost = new URL(proxy.origin).hostname;
    } catch {
      return true;
    }
    const appHost = win.location.hostname;
    if (proxyHost === appHost && win.location.origin === proxy.origin) return true;
    try {
      cleanForeignCookies(win.document, {
        appHost,
        proxyHost,
        registrable: proxy.cookieHygiene === 'registrable',
        https: win.location.protocol === 'https:',
      });
    } catch (err) {
      console.warn('[gnome] cookie hygiene failed', err);
    }
    return true;
  };
  // The configuration may still be loading: try every second for a minute, then at the regular times.
  let tries = 0;
  const early = win.setInterval(() => {
    if (run() || ++tries >= 60) win.clearInterval(early);
  }, 1000);
  if (run()) win.clearInterval(early);
  const timer = win.setInterval(run, HYGIENE_INTERVAL_MS);
  const onVisible = (): void => {
    if (win.document.visibilityState === 'visible') run();
  };
  win.document.addEventListener('visibilitychange', onVisible);
  return () => {
    win.clearInterval(early);
    win.clearInterval(timer);
    win.document.removeEventListener('visibilitychange', onVisible);
  };
}
