/**
 * Omnibox input → navigation target.
 *
 *   parseOmnibox('example.com')          → { kind: 'url', href: 'https://example.com/', fallbackHref: 'http://…' }
 *   parseOmnibox('how to tie a knot')    → { kind: 'search', href: 'https://duckduckgo.com/?q=how%20to…' }
 *   parseOmnibox('gnome://settings')     → { kind: 'internal', href: '/settings' }
 *
 * Rules: explicit http(s) URLs are kept; other schemes (javascript:, data:, file:, …) are never navigated and are
 * searched instead; bare hosts must end in a real TLD (IANA list, loaded lazily — see loadTldList), be localhost,
 * an IPv4/IPv6 literal, or a single-label host with an explicit port or trailing slash; whitespace makes it a search
 * unless it only appears after the host ("example.com/a b"); a leading "?" forces a search. Scheme-less hosts get
 * https:// (with an http:// fallback for the engine), except localhost, IP literals and single-label hosts which
 * get http://.
 */
import { SEARCH_ENGINES } from '../settings/defaults';
import type { Settings } from '../settings/schema';

export type OmniboxKind = 'url' | 'search' | 'internal';

export interface OmniboxResult {
  kind: OmniboxKind;
  /** Absolute URL for url/search; an app route path ("/settings") for internal. */
  href: string;
  /** For scheme-less input upgraded to https: the http:// URL to retry if the https connection fails. */
  fallbackHref?: string;
  /** The search terms (kind === 'search'). */
  query?: string;
}

export interface SearchOptions {
  searchEngine: Settings['browser']['searchEngine'];
  customSearchUrl: string;
}

export const DEFAULT_SEARCH: SearchOptions = { searchEngine: 'duckduckgo', customSearchUrl: '' };

// ── TLD list (lazy) ──────────────────────────────────────────────────────────────────────────────────────────────

let tlds: ReadonlySet<string> | null = null;
let tldPromise: Promise<void> | null = null;

/** Loads the IANA TLD list (separate chunk). Until it is loaded a conservative heuristic is used. */
export function loadTldList(): Promise<void> {
  tldPromise ??= import('./tlds')
    .then((m) => {
      tlds = m.TLDS;
    })
    .catch((err: unknown) => {
      tldPromise = null;
      console.warn('[gnome] could not load the TLD list', err);
    });
  return tldPromise;
}

export function isTldListLoaded(): boolean {
  return tlds !== null;
}

/** Special-use names that are not in the IANA root zone but are clearly meant as hosts. */
const EXTRA_TLDS = new Set(['onion']);

export function isKnownTld(label: string): boolean {
  const tld = label.toLowerCase();
  if (EXTRA_TLDS.has(tld)) return true;
  if (tlds) return tlds.has(tld);
  return /^[a-z]{2,24}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld);
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Builds a search URL from the configured engine (custom templates must be http(s) and contain %s). */
export function searchUrl(query: string, opts: SearchOptions = DEFAULT_SEARCH): string {
  let template = SEARCH_ENGINES.duckduckgo.template;
  if (opts.searchEngine === 'custom') {
    if (isValidSearchTemplate(opts.customSearchUrl)) template = opts.customSearchUrl;
  } else {
    template = SEARCH_ENGINES[opts.searchEngine]?.template ?? template;
  }
  const encoded = encodeURIComponent(query);
  return template.replace(/%s/g, () => encoded);
}

export function isValidSearchTemplate(template: string): boolean {
  if (!template || !template.includes('%s')) return false;
  try {
    const u = new URL(template.replace(/%s/g, 'gnome'));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function search(query: string, opts: SearchOptions): OmniboxResult {
  return { kind: 'search', href: searchUrl(query, opts), query };
}

/** Maps `gnome://<page>` to an app route path. */
export function internalPath(rest: string): string {
  const trimmed = rest.replace(/^\/+/, '');
  const m = /^([^?#]*)(.*)$/s.exec(trimmed);
  const rawPath = (m?.[1] ?? '').replace(/\/+$/, '');
  const tail = m?.[2] ?? '';
  const segments = rawPath
    .split('/')
    .map((s) => decodeSafe(s).toLowerCase())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .map((s) => encodeURIComponent(s));
  const first = segments[0] ?? '';
  if (segments.length === 0 || ['home', 'newtab', 'start'].includes(first)) return `/${tail}`;
  if (first === 'browser') segments[0] = 'browse';
  return `/${segments.join('/')}${tail}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')))
  );
}

function isIPv6Literal(text: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return false;
  if ((text.match(/:/g) ?? []).length < 2) return false;
  try {
    return new URL(`http://[${text}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

function parseHttp(candidate: string): URL | null {
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────────────────────────────────────────

export function parseOmnibox(input: string, opts: SearchOptions = DEFAULT_SEARCH): OmniboxResult | null {
  // Strip zero-width characters and surrounding whitespace (common in pasted links).
  const text = input.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (!text) return null;

  if (text.startsWith('?')) {
    const q = text.slice(1).trim();
    return q ? search(q, opts) : null;
  }

  const internal = /^gnome:(?:\/\/)?(.*)$/is.exec(text);
  if (internal) return { kind: 'internal', href: internalPath(internal[1] ?? '') };

  if (/^about:blank$/i.test(text)) return { kind: 'url', href: 'about:blank' };

  // Bare IPv6 literal ("::1", "2001:db8::1").
  if (isIPv6Literal(text)) {
    const u = parseHttp(`http://[${text}]/`);
    if (u) return { kind: 'url', href: u.href };
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const looksLikeHostPort = /^[^\s:/?#@]+:\d{1,5}(?:[/?#]|$)/.test(text);
  if (scheme && !looksLikeHostPort) {
    const s = (scheme[1] ?? '').toLowerCase();
    if (s === 'http' || s === 'https') {
      if (/\s/.test(text.replace(/^[a-z]+:\/*/i, '').split(/[/?#]/)[0] ?? '')) return search(text, opts);
      const u = parseHttp(text);
      if (u && u.hostname) return { kind: 'url', href: u.href };
      return search(text, opts);
    }
    // javascript:, data:, file:, mailto:, chrome:, view-source:, … are never opened from the omnibox.
    return search(text, opts);
  }

  if (/\s/.test(text)) {
    // "example.com/some page" is still an address when the host part has no whitespace (the URL parser encodes
    // the rest); "what is example.com" is a search.
    const cut = text.search(/[/?#]/);
    if (cut <= 0 || /\s/.test(text.slice(0, cut))) return search(text, opts);
  }

  const m = /^(\[[^\]]+\]|[^/?#:]+)(?::(\d{1,5}))?([/?#].*)?$/s.exec(text);
  if (!m) return search(text, opts);
  const hostRaw = m[1] ?? '';
  const port = m[2];
  const rest = m[3] ?? '';
  if (hostRaw.includes('@')) return search(text, opts); // userinfo without a scheme: likely an email address
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return search(text, opts);

  const host = hostRaw.replace(/\.$/, '');

  // Bracketed IPv6 with optional port.
  if (host.startsWith('[')) {
    const u = parseHttp(`http://${text}`);
    return u ? { kind: 'url', href: u.href } : search(text, opts);
  }

  if (/^[\d.]+$/.test(host)) {
    if (!isIPv4(host)) return search(text, opts); // "3.14", "1.2.3" are searches, not URLs
    const u = parseHttp(`http://${text}`);
    return u ? { kind: 'url', href: u.href } : search(text, opts);
  }

  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    const u = parseHttp(`http://${text}`);
    return u ? { kind: 'url', href: u.href } : search(text, opts);
  }

  // Let the URL parser do IDNA (münchen.de → xn--mnchen-3ya.de) and reject invalid hosts.
  const probe = parseHttp(`http://${host}/`);
  if (!probe) return search(text, opts);
  const ascii = probe.hostname.replace(/\.$/, '');
  const labels = ascii.split('.');
  if (!labels.every((l) => LABEL_RE.test(l))) return search(text, opts);

  if (labels.length === 1) {
    // Single-label intranet-style host: only with an explicit port or a bare trailing slash.
    if (port !== undefined || rest === '/') {
      const u = parseHttp(`http://${text}`);
      return u ? { kind: 'url', href: u.href } : search(text, opts);
    }
    return search(text, opts);
  }

  const tld = labels[labels.length - 1] ?? '';
  if (/^\d+$/.test(tld) || !isKnownTld(tld)) return search(text, opts);

  const secure = parseHttp(`https://${text}`);
  const plain = parseHttp(`http://${text}`);
  if (!secure || !plain) return search(text, opts);
  return { kind: 'url', href: secure.href, fallbackHref: plain.href };
}

/** Validates user-entered links (quick links, start pages): returns a normalized http(s) URL or null. */
export function normalizeLinkUrl(input: string): string | null {
  const r = parseOmnibox(input);
  return r && r.kind === 'url' && r.href !== 'about:blank' ? r.href : null;
}

/**
 * Characters that must stay percent-encoded when a URL is shown decoded: controls, bidi overrides/isolates and
 * invisible formatting characters can make a displayed address read differently from where it goes (spoofing).
 */
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f­؜ᅟᅠ᠎​-‏‪-‮⁠-⁯ㅤ﻿￰-￻]/g;

/** Compact display form: "example.com/path?q" (scheme, "www." and a lone trailing slash removed). */
export function displayUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return href;
    const host = u.host.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    let out = `${host}${path}${u.search}`;
    try {
      out = decodeURI(out).replace(UNSAFE_DISPLAY_CHARS, (c) => encodeURIComponent(c));
    } catch {
      /* keep encoded */
    }
    return u.protocol === 'http:' ? `http://${out}` : out;
  } catch {
    return href;
  }
}

/** Hostname without "www." (empty string for invalid URLs). */
export function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Letter used for monogram tiles: first letter/digit of the title, else of the host. */
export function monogram(title: string | null | undefined, href: string): string {
  const source = (title ?? '').trim() || hostOf(href);
  const ch = /[\p{L}\p{N}]/u.exec(source)?.[0];
  return (ch ?? '•').toLocaleUpperCase();
}
