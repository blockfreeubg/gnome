/** Focus management helpers: tabbable discovery, focus traps, focus restoration, typeahead buffers. */

const TABBABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',');

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
}

/** Elements reachable with Tab inside `root`, in DOM order. */
export function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest('[inert]') && isVisible(el),
  );
}

export function focusFirst(root: HTMLElement, opts: { preferSelector?: string } = {}): boolean {
  const preferred = opts.preferSelector ? root.querySelector<HTMLElement>(opts.preferSelector) : null;
  const target = preferred ?? root.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? tabbables(root)[0];
  if (target) {
    target.focus({ preventScroll: true });
    return true;
  }
  if (root.tabIndex < 0 && !root.hasAttribute('tabindex')) root.tabIndex = -1;
  root.focus({ preventScroll: true });
  return false;
}

/**
 * Attachment: keeps Tab / Shift+Tab inside the node (for non-modal surfaces that must still trap, and as a
 * belt-and-braces for modal <dialog>s which already make the rest of the page inert).
 */
export function trapFocus(node: HTMLElement): () => void {
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Tab') return;
    const items = tabbables(node);
    if (items.length === 0) {
      ev.preventDefault();
      node.focus({ preventScroll: true });
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (ev.shiftKey && (active === first || !node.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !node.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  };
  node.addEventListener('keydown', onKey);
  return () => node.removeEventListener('keydown', onKey);
}

/** Remembers the focused element and returns a function that restores focus to it (if still connected). */
export function captureFocus(): () => void {
  const prev = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  return () => {
    if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
  };
}

/** Typeahead buffer for menus/listboxes: collects printable keys typed within `timeout` ms. */
export function createTypeahead(timeout = 600): (key: string) => string | null {
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (key: string) => {
    if (key.length !== 1 || key === ' ') return null;
    buffer += key.toLowerCase();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      buffer = '';
    }, timeout);
    return buffer;
  };
}

/** Finds the next index whose label starts with `query`, starting after `from` and wrapping. */
export function matchTypeahead(labels: readonly string[], query: string, from: number, enabled: (i: number) => boolean = () => true): number {
  const n = labels.length;
  // Repeating one character cycles through items starting with it.
  const q = query.length > 1 && [...query].every((c) => c === query[0]) ? query[0]! : query;
  const start = q.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (enabled(i) && (labels[i] ?? '').toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

export function isEditable(target: EventTarget | null | undefined): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const nonText = ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'];
    return !nonText.includes(target.type) && !target.readOnly && !target.disabled;
  }
  return false;
}
