/**
 * Context menus (ENGINE-PROTOCOL §6.8): on `contextmenu` in a proxied document (any depth) the browser's menu is
 * prevented (Shift+right-click keeps it) and `tab.contextMenu` goes to the app with engine-host viewport coordinates
 * (client coordinates plus every frame's offset up to the tab frame, times the tab's zoom, plus the tab frame's own
 * offset), rounded and clamped, and the target: link, image, editable, selection or page, with real URLs (http(s)
 * only) and the selection cut to LIMITS.maxSelectionLength (`selectionTruncated`).
 */
import { LIMITS, fitInt, normalizeHttpUrl, sanitizeText } from '../../shared/engine-protocol';
import type { ContextTarget, EventMap } from '../../shared/engine-protocol';
import type { Natives } from '../natives';
import { isEditableTarget } from './keys';

const COORD_MIN = -32_768;
const COORD_MAX = 32_767;

/** Cuts a selection to the protocol limit without splitting a surrogate pair. */
export function fitSelection(text: string): { selectionText: string | null; selectionTruncated: boolean } {
  if (!text) return { selectionText: null, selectionTruncated: false };
  const clean = sanitizeText(text, true);
  if (clean.length <= LIMITS.maxSelectionLength) return { selectionText: clean || null, selectionTruncated: false };
  let end = LIMITS.maxSelectionLength;
  const last = clean.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { selectionText: clean.slice(0, end), selectionTruncated: true };
}

/** Engine-host viewport coordinates of a point inside a tab frame (frame offsets inside the tab, then the zoom). */
export function hostPoint(client: { x: number; y: number }, nestedOffsets: ReadonlyArray<{ x: number; y: number }>, tabFrame: { x: number; y: number }, zoom: number): { x: number; y: number } {
  let x = client.x;
  let y = client.y;
  for (const o of nestedOffsets) {
    x += o.x;
    y += o.y;
  }
  return {
    x: fitInt(tabFrame.x + x * zoom, COORD_MIN, COORD_MAX),
    y: fitInt(tabFrame.y + y * zoom, COORD_MIN, COORD_MAX),
  };
}

export function contextTarget(parts: { linkUrl: string | null; srcUrl: string | null; editable: boolean; selection: string }): ContextTarget {
  const linkUrl = parts.linkUrl === null ? null : normalizeHttpUrl(parts.linkUrl);
  const srcUrl = parts.srcUrl === null ? null : normalizeHttpUrl(parts.srcUrl);
  const sel = fitSelection(parts.selection);
  const kind: ContextTarget['kind'] = linkUrl ? 'link' : srcUrl ? 'image' : parts.editable ? 'editable' : sel.selectionText ? 'selection' : 'page';
  return { kind, linkUrl, srcUrl, selectionText: sel.selectionText, selectionTruncated: sel.selectionTruncated, editable: parts.editable };
}

export interface ContextMenuSink {
  realUrl(raw: string): string | null;
  /** The frame elements from `win` up to and including the tab iframe (innermost first). */
  frameChain(win: Window): Element[];
  zoom(): number;
  send(p: Omit<EventMap['tab.contextMenu'], 'tabId'>): void;
}

export function installContextMenu(win: Window, N: Natives, sink: ContextMenuSink): void {
  N.on.call(
    win,
    'contextmenu',
    ((ev: MouseEvent) => {
      try {
        if (!ev.isTrusted || N.mouseShift.call(ev)) return; // Shift+right-click keeps the browser's own menu
        N.preventDefault.call(ev);
        let el = N.eventTarget.call(ev) as Node | null;
        if (el && N.nodeType.call(el) !== 1) el = N.parentElement.call(el);
        const link = el ? N.closest.call(el, 'a[href], area[href]') : null;
        const img = el ? N.closest.call(el, 'img') : null;
        const linkUrl = link ? sink.realUrl(N.localName.call(link) === 'area' ? N.areaHref.call(link) : N.anchorHref.call(link)) : null;
        const srcUrl = img ? sink.realUrl(N.imgCurrentSrc.call(img)) : null;
        let selection = '';
        try {
          const s = N.getSelection.call(win);
          selection = s ? N.selectionToString.call(s) : '';
        } catch {
          selection = '';
        }
        const chain = sink.frameChain(win);
        const tabFrame = chain[chain.length - 1];
        // DOMRects of page frame elements are page-realm objects: read them with this realm's getters.
        const nested = chain.slice(0, -1).map((fe) => {
          const r = N.rect.call(fe);
          return { x: N.rectLeft.call(r) + N.clientLeft.call(fe), y: N.rectTop.call(r) + N.clientTop.call(fe) };
        });
        const tr = tabFrame ? N.rect.call(tabFrame) : null;
        const p = hostPoint({ x: N.clientX.call(ev), y: N.clientY.call(ev) }, nested, { x: tr ? N.rectLeft.call(tr) : 0, y: tr ? N.rectTop.call(tr) : 0 }, sink.zoom());
        sink.send({ x: p.x, y: p.y, target: contextTarget({ linkUrl, srcUrl, editable: isEditableTarget(N, el), selection }) });
      } catch {
        /* never break the page */
      }
    }) as (ev: never) => void,
    true,
  );
}
