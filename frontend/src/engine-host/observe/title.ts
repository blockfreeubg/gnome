/**
 * Title and favicon of a tab's top document (ENGINE-PROTOCOL §5): the title through this realm's `Document.title`
 * getter whenever `<head>` changes (fitted to LIMITS.maxTitleLength), the favicon as a base64 data: URL of at most
 * 64 KiB fetched through the tab's engine (the proxied URL of `link[rel~=icon]`, else `/favicon.ico` of the page),
 * `null` when there is none or it is larger.
 */
import { LIMITS, fitText, sanitizeText } from '../../shared/engine-protocol';
import type { Natives } from '../natives';

const ICON_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/avif': 'image/avif',
  'image/bmp': 'image/bmp',
  'image/x-icon': 'image/x-icon',
  'image/vnd.microsoft.icon': 'image/vnd.microsoft.icon',
  'image/ico': 'image/x-icon',
  'image/icon': 'image/x-icon',
  'image/svg+xml': 'image/svg+xml',
};

/** The favicon MIME type from the response type, else sniffed from the bytes; null when it is not an image we show. */
export function iconMime(contentType: string | null, bytes: Uint8Array): string | null {
  const bare = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const known = ICON_TYPES[bare];
  if (known) return known;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return null;
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** The data: URL tab.favicon carries, or null (missing, not an image, or over LIMITS.faviconMaxBytes). */
export function faviconDataUrl(contentType: string | null, bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > LIMITS.faviconMaxBytes) return null;
  const mime = iconMime(contentType, bytes);
  return mime ? `data:${mime};base64,${base64(bytes)}` : null;
}

export function fitTitle(raw: string): string {
  return fitText(sanitizeText(raw.replace(/\s+/g, ' ').trim()), LIMITS.maxTitleLength);
}

/** Watches the document title; `send` gets each new fitted title. Returns a function that reads it now. */
export function installTitleObserver(win: Window, N: Natives, send: (title: string) => void): () => void {
  // An empty title at document start is not news: the first title sent is the first non-empty one (or '' at load).
  let last: string | null = '';
  let observed: Node | null = null;
  const doc = N.winDocument.call(win);
  const read = (): void => {
    try {
      const t = fitTitle(String(N.docTitle.call(doc) ?? ''));
      if (t !== last) {
        last = t;
        send(t);
      }
    } catch {
      /* the document went away */
    }
  };
  const observer = new N.MutationObserver(() => {
    attach();
    read();
  });
  const attach = (): void => {
    const head = N.docHead.call(doc);
    const target = head ?? N.docElement.call(doc);
    if (!target || target === observed) return;
    observed = target;
    observer.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel'] });
  };
  attach();
  N.on.call(doc, 'DOMContentLoaded', (() => {
    attach();
    read();
  }) as (ev: never) => void);
  N.on.call(win, 'load', (() => {
    if (last === '') last = null;
    read();
  }) as (ev: never) => void);
  return read;
}

/** The raw href of the document's icon link (`link[rel~=icon]`), or null. */
export function iconLinkHref(win: Window, N: Natives): string | null {
  try {
    const doc = N.winDocument.call(win);
    const links = N.querySelectorAll.call(doc, 'link[rel]');
    const n = N.nodeListLength.call(links);
    for (let i = 0; i < n; i++) {
      const l = N.nodeListItem.call(links, i);
      const rel = (N.getAttribute.call(l, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('icon')) return N.linkHref.call(l) || null;
    }
  } catch {
    /* ignore */
  }
  return null;
}
