/**
 * App-wide context menu (rendered by <ContextMenuHost />).
 *
 *   oncontextmenu={(ev) => openContextMenu(ev, [
 *     { label: 'Open in new tab', icon: SquareArrowOutUpRight, shortcut: 'newTab', onSelect: … },
 *     { kind: 'separator' },
 *     { kind: 'checkbox', label: 'Show bookmarks bar', checked, onToggle: … },
 *     { kind: 'submenu', label: 'Move to', items: [...] },
 *   ])}
 *
 * Accepts a mouse event (opens at the pointer), a keyboard event (opens at the focused element — ContextMenu key /
 * Shift+F10) or a point. The menu restores focus to where it was when closed with Escape or after a selection.
 */
import { captureFocus } from '../../components/focus';
import { closeOpenMenus, type MenuAnchor, type MenuCloseReason, type MenuItem } from '../../components/menu';

export const contextMenuState = $state<{
  open: boolean;
  items: MenuItem[];
  anchor: MenuAnchor | null;
  label: string;
  autofocus: 'first' | 'menu';
  key: number;
}>({ open: false, items: [], anchor: null, label: 'Context menu', autofocus: 'menu', key: 0 });

let restore: (() => void) | null = null;

export function openContextMenu(
  ev: MouseEvent | KeyboardEvent | { x: number; y: number },
  items: MenuItem[],
  opts: { label?: string } = {},
): void {
  if (items.length === 0) return;
  let anchor: MenuAnchor;
  let autofocus: 'first' | 'menu' = 'menu';
  if ('clientX' in ev) {
    ev.preventDefault();
    ev.stopPropagation();
    // Keyboard-generated contextmenu events (ContextMenu key) report 0,0; anchor to the target instead.
    if (ev.clientX === 0 && ev.clientY === 0 && ev.target instanceof HTMLElement) {
      const r = ev.target.getBoundingClientRect();
      anchor = { kind: 'point', x: r.left + 8, y: r.bottom };
      autofocus = 'first';
    } else {
      anchor = { kind: 'point', x: ev.clientX, y: ev.clientY };
    }
  } else if ('key' in ev) {
    ev.preventDefault();
    const target = ev.target instanceof HTMLElement ? ev.target : document.activeElement;
    const r = target instanceof HTMLElement ? target.getBoundingClientRect() : new DOMRect(0, 0, 0, 0);
    anchor = { kind: 'point', x: r.left + 8, y: r.bottom };
    autofocus = 'first';
  } else {
    // A point: a proxied page's context menu (an engine event). Nothing in this document saw a pointer event, so
    // close any other open menu first (the toolbar's Browser menu, an earlier context menu).
    anchor = { kind: 'point', x: ev.x, y: ev.y };
    closeOpenMenus();
  }
  restore = captureFocus();
  contextMenuState.items = items;
  contextMenuState.anchor = anchor;
  contextMenuState.label = opts.label ?? 'Context menu';
  contextMenuState.autofocus = autofocus;
  contextMenuState.key++;
  contextMenuState.open = true;
}

export function closeContextMenu(reason: MenuCloseReason = 'escape'): void {
  if (!contextMenuState.open) return;
  contextMenuState.open = false;
  const r = restore;
  restore = null;
  if (reason !== 'outside') r?.();
}

/** Keyboard helper: true for the keys that should open a context menu on the focused element. */
export function isContextMenuKey(ev: KeyboardEvent): boolean {
  return ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10');
}
