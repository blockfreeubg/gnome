/**
 * Forwarded shortcuts (ENGINE-PROTOCOL §6.7): in every proxied document (any depth) trusted `keydown` events are
 * matched in the capture phase with the same src/lib/keys.ts functions the shell uses (layout-independent letters and
 * digits from `KeyboardEvent.code`); combos that edit text are skipped while the target is editable, composing input
 * is ignored. A match is prevented in the frame and sent as `tab.key` with the string the app sent.
 */
import { isTextEditingCombo, matchCombo, parseCombo } from '../../lib/keys';
import type { Combo, KeyEventLike } from '../../lib/keys';
import type { Natives } from '../natives';

export interface CompiledCombos {
  apple: boolean;
  list: Array<{ text: string; combo: Combo; editing: boolean }>;
}

/** The app's combos, parsed once per settings snapshot (invalid ones, which the validator cannot know, are skipped). */
export function compileCombos(combos: readonly string[], apple: boolean): CompiledCombos {
  const list: CompiledCombos['list'] = [];
  for (const text of combos) {
    const combo = parseCombo(text);
    if (combo) list.push({ text, combo, editing: isTextEditingCombo(text, apple) });
  }
  return { apple, list };
}

/** The combo string (as the app sent it) a key event matches, or null. */
export function forwardedCombo(compiled: CompiledCombos, ev: KeyEventLike, editable: boolean): string | null {
  if (ev.isComposing) return null;
  for (const c of compiled.list) {
    if (editable && c.editing) continue;
    if (matchCombo(c.combo, ev, compiled.apple)) return c.text;
  }
  return null;
}

const TEXT_INPUTS = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/** Whether a key event's target edits text (inputs that take text, textareas, contenteditable). */
export function isEditableTarget(N: Natives, target: unknown): boolean {
  try {
    if (!target || N.nodeType.call(target) !== 1) return false;
    const name = N.localName.call(target);
    if (name === 'textarea') return !N.textareaReadOnly.call(target);
    if (name === 'input') return TEXT_INPUTS.has(N.inputType.call(target).toLowerCase()) && !N.inputReadOnly.call(target);
    if (name === 'select') return false;
    return N.isContentEditable.call(target);
  } catch {
    return false;
  }
}

/** Reads a KeyboardEvent through this realm's getters (the page may have patched its own prototypes). */
export function keyEventOf(N: Natives, ev: Event): KeyEventLike {
  return {
    key: N.key.call(ev),
    code: N.code.call(ev),
    ctrlKey: N.ctrlKey.call(ev),
    altKey: N.altKey.call(ev),
    shiftKey: N.shiftKey.call(ev),
    metaKey: N.metaKey.call(ev),
    repeat: N.repeat.call(ev),
    isComposing: N.isComposing.call(ev),
  };
}

export function installKeyForwarding(
  win: Window,
  N: Natives,
  combos: () => CompiledCombos,
  send: (combo: string, repeat: boolean) => void,
): void {
  N.on.call(
    win,
    'keydown',
    ((ev: KeyboardEvent) => {
      try {
        // isTrusted is an unforgeable own property of every event.
        if (!ev.isTrusted) return;
        const compiled = combos();
        if (!compiled.list.length) return;
        const k = keyEventOf(N, ev);
        const combo = forwardedCombo(compiled, k, isEditableTarget(N, N.eventTarget.call(ev)));
        if (combo === null) return;
        N.preventDefault.call(ev);
        N.stopImmediatePropagation.call(ev);
        send(combo, !!k.repeat);
      } catch {
        /* never break the page's keys */
      }
    }) as (ev: never) => void,
    true,
  );
}
