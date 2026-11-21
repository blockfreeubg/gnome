/** Pure helpers behind VirtualList/VirtualGrid, floating layers and menu typeahead. */
import { describe, expect, it } from 'vitest';
import { computePosition, positionAtPoint } from './floating';
import { createTypeahead, matchTypeahead } from './focus';
import { cubicBezier } from './motion';
import { gridColumns, indexAt, prefixOffsets, visibleRange } from './virtual';

describe('virtualization math', () => {
  const fixed = prefixOffsets(100, () => 40);
  const varied = prefixOffsets(5, (i) => [10, 20, 30, 40, 50][i]!);

  it('builds prefix offsets', () => {
    expect(Array.from(varied)).toEqual([0, 10, 30, 60, 100, 150]);
    expect(fixed[100]).toBe(4000);
    expect(Array.from(prefixOffsets(2, () => -5))).toEqual([0, 0, 0]);
  });

  it('finds the item at a position', () => {
    expect(indexAt(varied, -10)).toBe(0);
    expect(indexAt(varied, 0)).toBe(0);
    expect(indexAt(varied, 9.9)).toBe(0);
    expect(indexAt(varied, 10)).toBe(1);
    expect(indexAt(varied, 99)).toBe(3);
    expect(indexAt(varied, 1e9)).toBe(4);
    expect(indexAt(prefixOffsets(0, () => 1), 50)).toBe(0);
  });

  it('computes the visible window with overscan', () => {
    expect(visibleRange(fixed, 0, 400, 0)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(fixed, 2000, 400, 80)).toEqual({ start: 48, end: 62 });
    expect(visibleRange(fixed, 3900, 400, 0)).toEqual({ start: 97, end: 99 });
    expect(visibleRange(prefixOffsets(0, () => 1), 0, 400, 0)).toEqual({ start: 0, end: -1 });
  });

  it('picks a responsive column count', () => {
    expect(gridColumns(1180, 220, 16)).toBe(5);
    expect(gridColumns(390, 160, 12)).toBe(2);
    expect(gridColumns(100, 220, 16)).toBe(1);
    expect(gridColumns(0, 220, 16)).toBe(1);
    expect(gridColumns(5000, 100, 10, 12)).toBe(12);
  });
});

describe('floating placement', () => {
  const vp = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };

  it('places on the requested side with alignment', () => {
    const anchor = { x: 100, y: 100, width: 80, height: 30 };
    expect(computePosition(anchor, size, 'bottom-start', { viewport: vp, offset: 4 })).toMatchObject({ x: 100, y: 134, side: 'bottom' });
    expect(computePosition(anchor, size, 'bottom-end', { viewport: vp, offset: 4 })).toMatchObject({ x: 8, y: 134 }); // shifted in
    expect(computePosition(anchor, size, 'right', { viewport: vp, offset: 6 })).toMatchObject({ x: 186, y: 65, side: 'right' });
  });

  it('flips when the requested side has no room, and reports the space left', () => {
    const nearBottom = { x: 400, y: 740, width: 100, height: 30 };
    const p = computePosition(nearBottom, size, 'bottom-start', { viewport: vp, offset: 6, padding: 8 });
    expect(p.side).toBe('top');
    expect(p.y).toBe(740 - 100 - 6);
    expect(p.available).toBe(740 - 6 - 8);
    expect(computePosition(nearBottom, size, 'bottom-start', { viewport: vp, flip: false }).side).toBe('bottom');
  });

  it('keeps context menus inside the viewport', () => {
    expect(positionAtPoint({ x: 10, y: 10 }, size, { viewport: vp })).toEqual({ x: 10, y: 10 });
    expect(positionAtPoint({ x: 950, y: 780 }, size, { viewport: vp })).toEqual({ x: 750, y: 680 });
    expect(positionAtPoint({ x: 500, y: 500 }, { width: 2000, height: 2000 }, { viewport: vp })).toEqual({ x: 8, y: 8 });
  });
});

describe('typeahead', () => {
  const labels = ['Open', 'Open in new tab', 'Copy address', 'Remove', 'Rename'];

  it('jumps to the next label starting with the typed text and cycles on repeats', () => {
    expect(matchTypeahead(labels, 'r', 0)).toBe(3);
    expect(matchTypeahead(labels, 'r', 3)).toBe(4);
    expect(matchTypeahead(labels, 'rr', 4)).toBe(3); // repeated letter cycles
    expect(matchTypeahead(labels, 'ren', 0)).toBe(4);
    expect(matchTypeahead(labels, 'open i', 0)).toBe(1);
    expect(matchTypeahead(labels, 'z', 0)).toBe(-1);
    expect(matchTypeahead(labels, 'r', 0, (i) => i !== 3)).toBe(4);
  });

  it('buffers printable keys and resets after a pause', async () => {
    const t = createTypeahead(20);
    expect(t('r')).toBe('r');
    expect(t('E')).toBe('re');
    expect(t('Enter')).toBeNull();
    expect(t(' ')).toBeNull();
    await new Promise((r) => setTimeout(r, 40));
    expect(t('c')).toBe('c');
  });
});

describe('easing', () => {
  it('cubicBezier is monotonic with fixed end points', () => {
    const ease = cubicBezier(0.2, 0.8, 0.2, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const v = ease(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(ease(0.5)).toBeGreaterThan(0.5); // ease-out front-loads progress
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 4);
  });
});
