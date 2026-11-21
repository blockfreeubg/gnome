import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_MENUS_EVENT } from '../../components/menu';

// Node test environment: a minimal window (EventTarget) and document for the focus helper.
const win = new EventTarget();
vi.stubGlobal('window', win);
vi.stubGlobal('document', { activeElement: null });

const { closeContextMenu, contextMenuState, openContextMenu } = await import('./contextmenu.svelte');

afterEach(() => closeContextMenu('outside'));

describe('openContextMenu', () => {
  it('closes every other open menu first when a proxied page’s context menu opens (a point, no pointer event here)', () => {
    const closed: number[] = [];
    const listener = (): void => void closed.push(contextMenuState.key);
    win.addEventListener(CLOSE_MENUS_EVENT, listener);
    try {
      const before = contextMenuState.key;
      openContextMenu({ x: 10, y: 20 }, [{ label: 'Open link in new tab', onSelect: () => {} }], { label: 'Page menu' });
      // Dispatched before the new menu opened (the key still had its old value).
      expect(closed).toEqual([before]);
      expect(contextMenuState.open).toBe(true);
      expect(contextMenuState.anchor).toEqual({ kind: 'point', x: 10, y: 20 });
    } finally {
      win.removeEventListener(CLOSE_MENUS_EVENT, listener);
    }
  });

  it('does not open an empty menu or close other menus for one', () => {
    let n = 0;
    const listener = (): void => void n++;
    win.addEventListener(CLOSE_MENUS_EVENT, listener);
    try {
      openContextMenu({ x: 1, y: 1 }, []);
      expect(n).toBe(0);
      expect(contextMenuState.open).toBe(false);
    } finally {
      win.removeEventListener(CLOSE_MENUS_EVENT, listener);
    }
  });
});
