/** Shared math + scroll helpers for VirtualList / VirtualGrid (pure functions are unit-tested). */

/** Prefix offsets for item heights: offsets[i] = top of item i; offsets[n] = total height. */
export function prefixOffsets(count: number, height: (index: number) => number): Float64Array {
  const out = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) out[i + 1] = out[i]! + Math.max(0, height(i));
  return out;
}

/** Index of the item containing `y` (binary search over prefix offsets). */
export function indexAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  if (y <= 0) return 0;
  if (y >= offsets[n]!) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Visible [start, end] (inclusive) for a viewport window, with overscan in px. */
export function visibleRange(
  offsets: Float64Array,
  scrollTop: number,
  viewport: number,
  overscan: number,
): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: -1 };
  const start = indexAt(offsets, scrollTop - overscan);
  const end = indexAt(offsets, scrollTop + viewport + overscan);
  return { start, end: Math.min(n - 1, end) };
}

/** Responsive column count for a grid. */
export function gridColumns(width: number, minItemWidth: number, gap: number, maxColumns = Infinity): number {
  if (width <= 0) return 1;
  const cols = Math.floor((width + gap) / (minItemWidth + gap));
  return Math.max(1, Math.min(maxColumns, cols));
}

/** Nearest scrollable ancestor (or null for the document). */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

export interface ScrollMetrics {
  scrollTop: number;
  viewport: number;
  /** Offset of the list's top inside the scroller's content. */
  listTop: number;
}

/** Observes a scroller (element or the window) and reports metrics relative to `list`, throttled to rAF. */
export function observeScroll(list: HTMLElement, scroller: HTMLElement | null, onChange: (m: ScrollMetrics) => void): () => void {
  let frame = 0;
  const measure = (): void => {
    frame = 0;
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      onChange({
        scrollTop: scroller.scrollTop,
        viewport: scroller.clientHeight,
        listTop: lr.top - sr.top + scroller.scrollTop,
      });
    } else {
      const lr = list.getBoundingClientRect();
      onChange({ scrollTop: window.scrollY, viewport: window.innerHeight, listTop: lr.top + window.scrollY });
    }
  };
  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  measure();
  const target: EventTarget = scroller ?? window;
  target.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const ro = new ResizeObserver(schedule);
  ro.observe(list);
  if (scroller) ro.observe(scroller);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    target.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    ro.disconnect();
  };
}

/** Scrolls so that [top, top + height) (list coordinates) is visible. */
export function ensureVisible(scroller: HTMLElement | null, listTop: number, top: number, height: number, padding = 8): void {
  const scrollTop = scroller ? scroller.scrollTop : window.scrollY;
  const viewport = scroller ? scroller.clientHeight : window.innerHeight;
  const absTop = listTop + top;
  let next = scrollTop;
  if (absTop - padding < scrollTop) next = absTop - padding;
  else if (absTop + height + padding > scrollTop + viewport) next = absTop + height + padding - viewport;
  if (next === scrollTop) return;
  if (scroller) scroller.scrollTop = next;
  else window.scrollTo({ top: next });
}
