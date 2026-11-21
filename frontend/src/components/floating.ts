/**
 * Positioning for floating layers (menus, popovers, listboxes, tooltips): place next to an anchor rect or point,
 * flip to the opposite side when there is not enough room, and shift along the cross axis to stay in the viewport.
 */
import { supportsPopover } from '../lib/platform';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Placement = Side | `${Side}-start` | `${Side}-end`;

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PositionOptions {
  offset?: number;
  padding?: number;
  viewport?: Size;
  flip?: boolean;
}

export interface Position {
  x: number;
  y: number;
  placement: Placement;
  side: Side;
  /** Available space on the chosen side (use as max-height / max-width). */
  available: number;
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function split(p: Placement): [Side, 'start' | 'center' | 'end'] {
  const [side, align] = p.split('-') as [Side, 'start' | 'end' | undefined];
  return [side, align ?? 'center'];
}

function coords(anchor: RectLike, size: Size, side: Side, align: 'start' | 'center' | 'end', offset: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  if (side === 'top' || side === 'bottom') {
    y = side === 'bottom' ? anchor.y + anchor.height + offset : anchor.y - size.height - offset;
    x = align === 'start' ? anchor.x : align === 'end' ? anchor.x + anchor.width - size.width : anchor.x + anchor.width / 2 - size.width / 2;
  } else {
    x = side === 'right' ? anchor.x + anchor.width + offset : anchor.x - size.width - offset;
    y = align === 'start' ? anchor.y : align === 'end' ? anchor.y + anchor.height - size.height : anchor.y + anchor.height / 2 - size.height / 2;
  }
  return { x, y };
}

function space(anchor: RectLike, side: Side, vp: Size, offset: number, padding: number): number {
  switch (side) {
    case 'bottom':
      return vp.height - (anchor.y + anchor.height) - offset - padding;
    case 'top':
      return anchor.y - offset - padding;
    case 'right':
      return vp.width - (anchor.x + anchor.width) - offset - padding;
    case 'left':
      return anchor.x - offset - padding;
  }
}

/** Pure positioning (unit-testable). */
export function computePosition(anchor: RectLike, size: Size, placement: Placement, opts: PositionOptions = {}): Position {
  const offset = opts.offset ?? 6;
  const padding = opts.padding ?? 8;
  const vp = opts.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  let [side, align] = split(placement);
  const need = side === 'top' || side === 'bottom' ? size.height : size.width;
  if (opts.flip !== false) {
    const here = space(anchor, side, vp, offset, padding);
    const there = space(anchor, OPPOSITE[side], vp, offset, padding);
    if (here < need && there > here) side = OPPOSITE[side];
  }
  let { x, y } = coords(anchor, size, side, align, offset);
  // Shift into the viewport.
  x = Math.min(Math.max(x, padding), Math.max(padding, vp.width - size.width - padding));
  y = Math.min(Math.max(y, padding), Math.max(padding, vp.height - size.height - padding));
  const finalPlacement = (align === 'center' ? side : `${side}-${align}`) as Placement;
  return { x: Math.round(x), y: Math.round(y), placement: finalPlacement, side, available: Math.max(0, space(anchor, side, vp, offset, padding)) };
}

export type AnchorSource = HTMLElement | RectLike | (() => RectLike);

function readAnchor(a: AnchorSource): RectLike {
  if (typeof a === 'function') return a();
  if (a instanceof HTMLElement) {
    const r = a.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return a;
}

/**
 * Keeps `floating` positioned next to `anchor` (on scroll, resize and size changes). The element must be
 * position: fixed (top-layer popovers are). Returns a cleanup function.
 */
export function autoPosition(
  anchor: AnchorSource,
  floating: HTMLElement,
  placement: Placement,
  opts: PositionOptions & { matchWidth?: boolean; onPosition?: (p: Position) => void } = {},
): () => void {
  let frame = 0;
  const update = (): void => {
    frame = 0;
    const a = readAnchor(anchor);
    if (opts.matchWidth) floating.style.minWidth = `${Math.round(a.width)}px`;
    const size = { width: floating.offsetWidth, height: floating.offsetHeight };
    const p = computePosition(a, size, placement, opts);
    floating.style.left = `${p.x}px`;
    floating.style.top = `${p.y}px`;
    floating.dataset.side = p.side;
    opts.onPosition?.(p);
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  update();
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  ro?.observe(floating);
  if (anchor instanceof HTMLElement) ro?.observe(anchor);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    ro?.disconnect();
  };
}

/**
 * Attachment: shows the element in the browser's top layer (above modal dialogs, no z-index wars) using the
 * Popover API, or falls back to a fixed, high z-index layer.
 */
export function topLayer(node: HTMLElement): () => void {
  node.style.position = 'fixed';
  if (supportsPopover()) {
    node.setAttribute('popover', 'manual');
    try {
      node.showPopover();
    } catch {
      /* already shown or detached */
    }
    return () => {
      try {
        node.hidePopover();
      } catch {
        /* already hidden */
      }
    };
  }
  node.style.zIndex = 'var(--z-popover)';
  return () => undefined;
}

/** Context-menu placement at a pointer position: opens down-right, flipping left/up when it would overflow. */
export function positionAtPoint(point: { x: number; y: number }, size: Size, opts: { padding?: number; viewport?: Size } = {}): { x: number; y: number } {
  const pad = opts.padding ?? 8;
  const vp = opts.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  let x = point.x;
  let y = point.y;
  if (x + size.width > vp.width - pad) x = point.x - size.width;
  if (y + size.height > vp.height - pad) y = point.y - size.height;
  x = Math.min(Math.max(x, pad), Math.max(pad, vp.width - size.width - pad));
  y = Math.min(Math.max(y, pad), Math.max(pad, vp.height - size.height - pad));
  return { x: Math.round(x), y: Math.round(y) };
}
