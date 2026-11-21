/** Menu item model shared by <Menu>, <MenuList> and the programmatic context menu (app/overlays). */
import type { LucideIcon } from '@lucide/svelte';
import type { Placement } from './floating';
import { bindingFor } from '../app/shortcuts';
import { SHORTCUT_ACTIONS, type ShortcutAction } from '../settings/schema';

interface Base {
  id?: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** A combo ("Alt+T") or a ShortcutAction name (shows the user's current binding). */
  shortcut?: string;
}

export interface MenuActionItem extends Base {
  kind?: 'item';
  danger?: boolean;
  /** Keep the menu open after activation. */
  keepOpen?: boolean;
  onSelect?: () => void;
}

export interface MenuCheckboxItem extends Base {
  kind: 'checkbox';
  checked: boolean;
  keepOpen?: boolean;
  onToggle?: (checked: boolean) => void;
}

export interface MenuRadioItem extends Base {
  kind: 'radio';
  checked: boolean;
  keepOpen?: boolean;
  onSelect?: () => void;
}

export interface MenuSubmenuItem extends Base {
  kind: 'submenu';
  items: MenuItem[];
}

export interface MenuSeparator {
  kind: 'separator';
}

export interface MenuGroupLabel {
  kind: 'label';
  label: string;
}

export type MenuItem =
  | MenuActionItem
  | MenuCheckboxItem
  | MenuRadioItem
  | MenuSubmenuItem
  | MenuSeparator
  | MenuGroupLabel;

export type InteractiveMenuItem = Exclude<MenuItem, MenuSeparator | MenuGroupLabel>;

export type MenuCloseReason = 'select' | 'escape' | 'tab' | 'outside' | 'back';

/** Window event every open top-level MenuList closes on (as on a click outside it). */
export const CLOSE_MENUS_EVENT = 'gnome:close-menus';

/**
 * Closes every open menu. For menus opened without a pointer event in this document (a proxied page's context menu
 * arrives as an engine event, and a click inside the page's iframe never reaches this document's pointerdown listener
 * nor, in every browser, its window `blur`), so two menus are never open at once.
 */
export function closeOpenMenus(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CLOSE_MENUS_EVENT));
}

export type MenuAnchor =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'element'; element: HTMLElement; placement?: Placement };

export function isInteractive(item: MenuItem): item is InteractiveMenuItem {
  return item.kind !== 'separator' && item.kind !== 'label';
}

const ACTIONS = new Set<string>(SHORTCUT_ACTIONS);

/** Resolves a shortcut hint: ShortcutAction names map to the user's binding. */
export function resolveShortcut(shortcut: string | undefined): string {
  if (!shortcut) return '';
  return ACTIONS.has(shortcut) ? bindingFor(shortcut as ShortcutAction) : shortcut;
}

/** Props a <Menu> trigger snippet spreads on its button (includes an attachment that captures the element). */
export interface MenuTriggerProps {
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onclick: (ev: MouseEvent) => void;
  onkeydown: (ev: KeyboardEvent) => void;
  [key: symbol]: (node: HTMLElement) => void;
}
