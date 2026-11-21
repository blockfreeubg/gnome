import { describe, expect, it } from 'vitest';
import { LIMITS, validateEventPayload } from '../../shared/engine-protocol';
import { contextTarget, fitSelection, hostPoint } from './context-menu';

describe('context menu fitting', () => {
  it('rounds fractional coordinates and applies frame offsets and zoom', () => {
    expect(hostPoint({ x: 10.4, y: 20.6 }, [], { x: 0, y: 0 }, 1)).toEqual({ x: 10, y: 21 });
    expect(hostPoint({ x: 10, y: 10 }, [{ x: 5.5, y: 4 }], { x: 0, y: 0 }, 2)).toEqual({ x: 31, y: 28 });
    expect(hostPoint({ x: 1e9, y: -1e9 }, [], { x: 0, y: 0 }, 1)).toEqual({ x: 32767, y: -32768 });
  });
  it('cuts a selection over the limit and flags it', () => {
    const long = 'x'.repeat(LIMITS.maxSelectionLength + 5);
    expect(fitSelection(long)).toEqual({ selectionText: 'x'.repeat(LIMITS.maxSelectionLength), selectionTruncated: true });
    const pair = `${'x'.repeat(LIMITS.maxSelectionLength - 1)}😀`;
    const cut = fitSelection(`${pair}y`);
    expect(cut.selectionText?.length).toBe(LIMITS.maxSelectionLength - 1);
    expect(fitSelection('')).toEqual({ selectionText: null, selectionTruncated: false });
  });
  it('produces targets the protocol accepts', () => {
    const cases = [
      contextTarget({ linkUrl: 'https://a.example/x', srcUrl: null, editable: false, selection: '' }),
      contextTarget({ linkUrl: 'javascript:alert(1)', srcUrl: 'https://a.example/i.png', editable: false, selection: '' }),
      contextTarget({ linkUrl: null, srcUrl: null, editable: true, selection: '' }),
      contextTarget({ linkUrl: null, srcUrl: null, editable: false, selection: 'y'.repeat(200_000) }),
      contextTarget({ linkUrl: null, srcUrl: null, editable: false, selection: '' }),
    ];
    expect(cases.map((c) => c.kind)).toEqual(['link', 'image', 'editable', 'selection', 'page']);
    expect(cases[1]?.linkUrl).toBeNull();
    for (const target of cases) expect(validateEventPayload('tab.contextMenu', { tabId: 1, x: 3, y: 4, target }).ok).toBe(true);
  });
});
