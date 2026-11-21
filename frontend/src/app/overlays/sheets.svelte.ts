/**
 * Programmatic sheets (rendered by <SheetHost />). The component receives its props plus `close()`.
 *
 *   const sheet = openSheet(TabSwitcher, { tabs }, { title: 'Tabs', side: 'bottom' });
 *   sheet.close();
 */
import type { Component } from 'svelte';

export interface SheetOptions {
  title: string;
  side?: 'left' | 'right' | 'bottom';
  size?: string;
  hideTitle?: boolean;
  onclose?: () => void;
}

export interface SheetRequest {
  id: number;
  component: Component<any>;
  props: Record<string, unknown>;
  options: SheetOptions;
  open: boolean;
}

let nextId = 0;

class SheetStack {
  items = $state<SheetRequest[]>([]);

  close(id: number): void {
    const s = this.items.find((x) => x.id === id);
    if (!s || !s.open) return;
    s.open = false;
    s.options.onclose?.();
    // Remove after the exit animation.
    setTimeout(() => {
      const i = this.items.findIndex((x) => x.id === id);
      if (i >= 0) this.items.splice(i, 1);
    }, 450);
  }
}

export const sheetStack = new SheetStack();

export function openSheet<P extends Record<string, unknown>>(
  component: Component<P & { close: () => void }>,
  props: P,
  options: SheetOptions,
): { id: number; close: () => void } {
  const id = ++nextId;
  sheetStack.items.push({ id, component, props, options, open: true });
  return { id, close: () => sheetStack.close(id) };
}
