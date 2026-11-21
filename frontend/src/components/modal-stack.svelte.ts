/**
 * Open modal dialogs, in the order they were shown (`showModal()`): the last one is on top of the browser's top
 * layer, and while it is open everything outside it is inert. Layers that must stay usable above modals (the toast
 * stack) move into the topmost one. Dialog, Sheet and the command palette report here.
 */
const stack = $state<HTMLDialogElement[]>([]);

/** Call right after `el.showModal()`. */
export function modalShown(el: HTMLDialogElement): void {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  stack.push(el);
}

/** Call after `el.close()` (or when the dialog closed itself, or its component is destroyed). Safe to repeat. */
export function modalClosed(el: HTMLDialogElement): void {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
}

/** The topmost open modal dialog, or null (reactive). */
export function topModal(): HTMLDialogElement | null {
  return stack.length ? (stack[stack.length - 1] ?? null) : null;
}
