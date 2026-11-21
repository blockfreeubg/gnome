/**
 * Keyboard combo parsing, formatting and matching (pure; shared by settings validation and app/shortcuts.ts).
 *
 * Combo syntax: modifiers and one key joined with "+", e.g. "Alt+T", "Mod+K", "Alt+Shift+ArrowLeft", "Alt+,".
 * Modifiers: Mod (⌘ on Apple, Ctrl elsewhere), Ctrl, Meta (⌘ / Windows key), Alt (⌥), Shift.
 * Keys: A–Z, 0–9, F1–F24, punctuation (- = [ ] \ ; ' , . / `), "Plus", and named keys (ArrowLeft, PageDown, …).
 */

export interface Combo {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key name (see normalizeKeyName). */
  key: string;
}

export interface ResolvedCombo {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** Minimal shape of a KeyboardEvent; lets proxied frames forward plain objects through dispatch(). */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
}

const NAMED_KEYS = [
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Enter',
  'Escape',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Plus',
  'ContextMenu',
] as const;

const KEY_ALIASES: Readonly<Record<string, string>> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  return: 'Enter',
  enter: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  plus: 'Plus',
  '+': 'Plus',
  contextmenu: 'ContextMenu',
  apps: 'ContextMenu',
};

const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
/** Characters typed with Shift on common layouts; accepted as keys so "Mod+?" style combos work. */
const SHIFTED_SYMBOLS = new Set(['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '{', '}', '|', ':', '"', '<', '>', '?', '~']);

const CODE_KEYS: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Space: 'Space',
  NumpadAdd: 'Plus',
  NumpadSubtract: '-',
  NumpadEnter: 'Enter',
  NumpadDecimal: '.',
  NumpadDivide: '/',
};

/** Returns the canonical key name, or null if the name is not a supported key. */
export function normalizeKeyName(raw: string): string | null {
  if (!raw) return null;
  if (raw.length === 1) {
    if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
    if (/^[0-9]$/.test(raw)) return raw;
    if (PUNCTUATION.has(raw) || SHIFTED_SYMBOLS.has(raw)) return raw;
    const alias = KEY_ALIASES[raw];
    return alias ?? null;
  }
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias) return alias;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (f) return `F${f[1]}`;
  const named = NAMED_KEYS.find((k) => k.toLowerCase() === lower);
  return named ?? null;
}

/** Parses a combo string. Returns null for invalid input. The empty string means "unbound" and also returns null. */
export function parseCombo(input: string): Combo | null {
  const text = input.trim();
  if (!text) return null;
  // "+" as the final key: "Alt++" → modifiers "Alt", key "+".
  let parts: string[];
  if (text.endsWith('++')) {
    parts = [...text.slice(0, -2).split('+'), '+'];
  } else if (text === '+') {
    parts = ['+'];
  } else {
    parts = text.split('+');
  }
  if (parts.some((p) => p.trim() === '')) return null;
  const combo: Combo = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (let i = 0; i < parts.length; i++) {
    const part = (parts[i] ?? '').trim();
    const lower = part.toLowerCase();
    const isLast = i === parts.length - 1;
    if (!isLast) {
      if (lower === 'mod' || lower === 'cmdorctrl' || lower === 'commandorcontrol') combo.mod = true;
      else if (lower === 'ctrl' || lower === 'control') combo.ctrl = true;
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super' || lower === 'win')
        combo.meta = true;
      else if (lower === 'alt' || lower === 'option' || lower === 'opt') combo.alt = true;
      else if (lower === 'shift') combo.shift = true;
      else return null;
      continue;
    }
    const key = normalizeKeyName(part);
    if (!key) return null;
    combo.key = key;
  }
  if (!combo.key) return null;
  return combo;
}

/** Canonical string form ("Mod+Ctrl+Meta+Alt+Shift+Key"). */
export function stringifyCombo(c: Combo): string {
  const parts: string[] = [];
  if (c.mod) parts.push('Mod');
  if (c.ctrl) parts.push('Ctrl');
  if (c.meta) parts.push('Meta');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  parts.push(c.key);
  return parts.join('+');
}

/** Normalizes a combo string to its canonical form; '' stays ''; invalid input returns null. */
export function normalizeCombo(input: string): string | null {
  if (input.trim() === '') return '';
  const c = parseCombo(input);
  return c ? stringifyCombo(c) : null;
}

export function resolveCombo(c: Combo, apple: boolean): ResolvedCombo {
  return {
    ctrl: c.ctrl || (c.mod && !apple),
    meta: c.meta || (c.mod && apple),
    alt: c.alt,
    shift: c.shift,
    key: c.key,
  };
}

function codeToKey(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return `F${fn[1]}`;
  return CODE_KEYS[code] ?? null;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Super', 'Hyper', 'Fn', 'CapsLock']);

/**
 * Determines the canonical key of an event, plus whether Shift was "consumed" to produce a symbol
 * (e.g. "+" on US layouts is Shift+=, so "Alt+Plus" should match without requiring Shift in the combo).
 * The produced character wins when it is a supported key (keeps non-US Latin layouts correct); otherwise the
 * physical key from `code` is used (macOS Option characters, non-Latin layouts).
 */
export interface EventKeyInfo {
  /** Canonical key produced by the press (or the physical key when the character is not a supported key). */
  key: string;
  /** Canonical key of the physical position (US layout names), if known. */
  physical: string | null;
  /** Shift was needed to produce a symbol, so it is not part of the combo. */
  shiftConsumed: boolean;
}

export function eventKey(ev: Pick<KeyEventLike, 'key' | 'code'>): EventKeyInfo | null {
  const physical = codeToKey(ev.code);
  if (!ev.key || MODIFIER_KEYS.has(ev.key) || ev.key === 'Dead' || ev.key === 'Unidentified' || ev.key === 'Process') {
    const usable = ev.key === 'Dead' || ev.key === 'Unidentified';
    return usable && physical ? { key: physical, physical, shiftConsumed: false } : null;
  }
  const produced = ev.key === '+' ? 'Plus' : normalizeKeyName(ev.key);
  if (produced) {
    const isSymbol = produced === 'Plus' || PUNCTUATION.has(produced) || SHIFTED_SYMBOLS.has(produced);
    const shiftConsumed = isSymbol && physical !== null && physical !== produced;
    return { key: produced, physical, shiftConsumed };
  }
  return physical ? { key: physical, physical, shiftConsumed: false } : null;
}

export function matchCombo(c: Combo, ev: KeyEventLike, apple: boolean): boolean {
  const r = resolveCombo(c, apple);
  if (ev.ctrlKey !== r.ctrl || ev.metaKey !== r.meta || ev.altKey !== r.alt) return false;
  const k = eventKey(ev);
  if (!k) return false;
  if (k.key === r.key) {
    if (k.shiftConsumed && !r.shift) return true;
    return ev.shiftKey === r.shift;
  }
  // Digits sit on the same physical keys everywhere, but layouts such as AZERTY need Shift to type them.
  if (/^[0-9]$/.test(r.key) && k.physical === r.key) return ev.shiftKey === r.shift;
  return false;
}

/** Builds a combo string from a key press (used to record bindings). Returns null for bare modifiers. */
export function comboFromEvent(ev: KeyEventLike, apple: boolean): string | null {
  const k = eventKey(ev);
  if (!k) return null;
  const c: Combo = {
    mod: apple ? ev.metaKey : ev.ctrlKey,
    ctrl: apple ? ev.ctrlKey : false,
    meta: apple ? false : ev.metaKey,
    alt: ev.altKey,
    shift: ev.shiftKey && !k.shiftConsumed,
    key: k.key,
  };
  return stringifyCombo(c);
}

const MAC_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '↩',
  Escape: 'esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Space: 'Space',
  Plus: '+',
};

const PC_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Del',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Space: 'Space',
  Plus: '+',
};

/** Key-cap labels for display, in platform order (⌃⌥⇧⌘ on Apple; Ctrl Alt Shift Win elsewhere). */
export function formatCombo(input: string, apple: boolean): string[] {
  const c = parseCombo(input);
  if (!c) return [];
  const r = resolveCombo(c, apple);
  const caps: string[] = [];
  if (apple) {
    if (r.ctrl) caps.push('⌃');
    if (r.alt) caps.push('⌥');
    if (r.shift) caps.push('⇧');
    if (r.meta) caps.push('⌘');
    caps.push(MAC_KEY_LABELS[r.key] ?? r.key);
  } else {
    if (r.ctrl) caps.push('Ctrl');
    if (r.alt) caps.push('Alt');
    if (r.shift) caps.push('Shift');
    if (r.meta) caps.push('Win');
    caps.push(PC_KEY_LABELS[r.key] ?? r.key);
  }
  return caps;
}

/** Accessible text for a combo, e.g. "Alt+Shift+T" / "Command+K". */
export function describeCombo(input: string, apple: boolean): string {
  const c = parseCombo(input);
  if (!c) return '';
  const r = resolveCombo(c, apple);
  const parts: string[] = [];
  if (r.ctrl) parts.push(apple ? 'Control' : 'Ctrl');
  if (r.alt) parts.push(apple ? 'Option' : 'Alt');
  if (r.shift) parts.push('Shift');
  if (r.meta) parts.push(apple ? 'Command' : 'Windows');
  parts.push(r.key);
  return parts.join('+');
}

/**
 * The combo in `aria-keyshortcuts` syntax: modifiers spelled as UI Events key values ("Control", "Meta", "Alt",
 * "Shift"), `Mod` resolved for the platform, e.g. "Mod+K" → "Control+K" (or "Meta+K" on Apple). '' when invalid.
 */
export function ariaKeyShortcut(input: string, apple: boolean): string {
  const c = parseCombo(input);
  if (!c) return '';
  const r = resolveCombo(c, apple);
  const parts: string[] = [];
  if (r.ctrl) parts.push('Control');
  if (r.alt) parts.push('Alt');
  if (r.shift) parts.push('Shift');
  if (r.meta) parts.push('Meta');
  parts.push(r.key);
  return parts.join('+');
}

export function sameCombo(a: string, b: string, apple: boolean): boolean {
  const ca = parseCombo(a);
  const cb = parseCombo(b);
  if (!ca || !cb) return false;
  const ra = resolveCombo(ca, apple);
  const rb = resolveCombo(cb, apple);
  return ra.ctrl === rb.ctrl && ra.meta === rb.meta && ra.alt === rb.alt && ra.shift === rb.shift && ra.key === rb.key;
}

const EDITING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete']);
const CLIPBOARD_KEYS = new Set(['A', 'C', 'V', 'X', 'Z', 'Y']);

/**
 * True for combos that also mean something while typing (caret movement, word deletion, clipboard, plain
 * characters). The dispatcher skips these while focus is in an editable field so text editing keeps working.
 */
export function isTextEditingCombo(input: string, apple: boolean): boolean {
  const c = parseCombo(input);
  if (!c) return false;
  const r = resolveCombo(c, apple);
  const primary = apple ? r.meta : r.ctrl;
  if (!r.ctrl && !r.meta && !r.alt) return true; // plain or Shift-only keys type text / move the caret
  if (EDITING_KEYS.has(r.key)) return true; // Alt/Ctrl/⌘ + arrows/Home/End/Backspace/Delete edit text
  if (primary && !r.alt && CLIPBOARD_KEYS.has(r.key)) return true;
  return false;
}
