/**
 * Page actions the app's menus ask for (ENGINE-PROTOCOL §6.10, capabilities `selectAll`, `print`): select all and
 * print on the tab's top document, through this realm's natives.
 */
import type { Natives } from './natives';

export function selectAll(N: Natives, win: Window | null): boolean {
  if (!win) return false;
  const doc = N.winDocument.call(win);
  const root = N.docBody.call(doc) ?? N.docElement.call(doc);
  const sel = N.getSelection.call(win);
  if (!root || !sel) return false;
  N.selectAllChildren.call(sel, root);
  try {
    N.focusWindow.call(win);
  } catch {
    /* focus refused */
  }
  return true;
}

export function printPage(N: Natives, win: Window | null): boolean {
  if (!win) return false;
  N.print.call(win);
  return true;
}
