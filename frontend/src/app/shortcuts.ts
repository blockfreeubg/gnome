/**
 * Global keyboard shortcut registry.
 *
 * Bindings come from `settings.browser.shortcuts` (ShortcutAction → combo, '' = unbound). Features register
 * handlers per action; the most recently registered handler runs first and may return `false` to pass the key on
 * (to the next handler, and finally to the browser's default behaviour).
 *
 *   const off = register('openSettings', () => navigate('/settings'));
 *
 * Keys pressed inside proxied pages arrive from the engine host as `tab.key` events (ENGINE-PROTOCOL §6.7); the
 * browser runs them through `dispatchForwardedShortcut()`, which splits the actions into ordinary and privileged ones.
 */
import { isEditable } from '../components/focus';
import { FORWARDED_PRIVILEGED_LIMIT, TokenBuckets } from '../shared/engine-protocol';
import {
  comboFromEvent,
  formatCombo,
  describeCombo,
  isTextEditingCombo,
  matchCombo,
  normalizeCombo,
  parseCombo,
  resolveCombo,
  sameCombo,
  type Combo,
  type KeyEventLike,
} from '../lib/keys';
import { isApplePlatform } from '../lib/platform';
import { RESERVED_COMBOS } from '../settings/defaults';
import { SHORTCUT_ACTIONS, type ShortcutAction } from '../settings/schema';
import { settings } from '../settings/store.svelte';

export type { KeyEventLike } from '../lib/keys';

/** Return false to decline (the key continues to the next handler / browser default). */
export type ShortcutHandler = (ev: KeyEventLike) => boolean | void;

export interface RegisterOptions {
  /** Also fire for auto-repeated keydowns (zoom, tab cycling). Default false. */
  repeat?: boolean;
}

interface Entry {
  handler: ShortcutHandler;
  repeat: boolean;
}

const handlers = new Map<ShortcutAction, Entry[]>();

export function register(action: ShortcutAction, handler: ShortcutHandler, opts: RegisterOptions = {}): () => void {
  const entry: Entry = { handler, repeat: opts.repeat ?? false };
  let stack = handlers.get(action);
  if (!stack) {
    stack = [];
    handlers.set(action, stack);
  }
  stack.push(entry);
  return () => {
    const s = handlers.get(action);
    const i = s?.indexOf(entry) ?? -1;
    if (s && i >= 0) s.splice(i, 1);
  };
}

export function hasHandler(action: ShortcutAction): boolean {
  return (handlers.get(action)?.length ?? 0) > 0;
}

/** Current combo for an action ('' when unbound). Reactive when read inside components/effects. */
export function bindingFor(action: ShortcutAction): string {
  return settings.value.browser.shortcuts[action] ?? '';
}

/** Key-cap labels for an action's binding (empty when unbound). */
export function shortcutCaps(action: ShortcutAction): string[] {
  const combo = bindingFor(action);
  return combo ? formatCombo(combo, isApplePlatform()) : [];
}

export function shortcutDescription(action: ShortcutAction): string {
  const combo = bindingFor(action);
  return combo ? describeCombo(combo, isApplePlatform()) : '';
}

interface Compiled {
  action: ShortcutAction;
  combo: Combo;
  raw: string;
}

let compiledFrom: Readonly<Record<ShortcutAction, string>> | null = null;
let compiled: Compiled[] = [];

function bindings(): Compiled[] {
  const map = settings.value.browser.shortcuts;
  if (map !== compiledFrom) {
    compiledFrom = map;
    compiled = [];
    for (const action of SHORTCUT_ACTIONS) {
      const raw = map[action];
      const combo = raw ? parseCombo(raw) : null;
      if (combo) compiled.push({ action, combo, raw });
    }
  }
  return compiled;
}

/** The action bound to a key event, if any (ignores whether a handler exists). */
export function actionForEvent(ev: KeyEventLike): ShortcutAction | null {
  const apple = isApplePlatform();
  return bindings().find((b) => matchCombo(b.combo, ev, apple))?.action ?? null;
}

export interface DispatchOptions {
  /** Whether the event target is a text field (defaults to inspecting ev.target). */
  editable?: boolean;
}

/**
 * Runs the handler bound to this key event. Returns true when a handler consumed it (the caller should then
 * preventDefault). Combos that also edit text (arrows, Backspace, clipboard keys…) are skipped in text fields.
 */
export function dispatch(ev: KeyEventLike, opts: DispatchOptions = {}): boolean {
  if (ev.isComposing) return false;
  const apple = isApplePlatform();
  const editable = opts.editable ?? isEditable(ev.target ?? null);
  for (const b of bindings()) {
    if (!matchCombo(b.combo, ev, apple)) continue;
    if (editable && isTextEditingCombo(b.raw, apple)) continue;
    const stack = handlers.get(b.action);
    if (!stack || stack.length === 0) continue;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (!entry || (ev.repeat && !entry.repeat)) continue;
      try {
        if (entry.handler(ev) !== false) return true;
      } catch (err) {
        console.error(`[gnome] shortcut handler for "${b.action}" failed`, err);
        return true;
      }
    }
  }
  return false;
}

function modalOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('dialog:modal') !== null;
}

/** Installs the window-level keydown listener. Global shortcuts pause while a modal dialog is open. */
export function installShortcutListener(): () => void {
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || modalOpen()) return;
    if (dispatch(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

// ── Shortcuts forwarded from proxied pages (ENGINE-PROTOCOL §6.7) ────────────────────────────────────────────────

/**
 * Forwarded actions that act on the active tab or the view and leave nothing behind. Every other action, including
 * any action added later, is privileged until it is classified here: it opens or closes tabs, changes what persists,
 * opens GNOME UI or moves the focus into it, so a forged `tab.key` (possible after an engine escape) must not trigger
 * it without a real key press.
 */
export const ORDINARY_FORWARDED: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'reload',
  'hardReload',
  'back',
  'forward',
  'home',
  'nextTab',
  'prevTab',
  'selectTab1',
  'selectTab2',
  'selectTab3',
  'selectTab4',
  'selectTab5',
  'selectTab6',
  'selectTab7',
  'selectTab8',
  'selectTab9',
  'findInPage',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'toggleSidebar',
]);

export function isPrivilegedForwarded(action: ShortcutAction): boolean {
  return !ORDINARY_FORWARDED.has(action);
}

export type ForwardedOutcome = 'ran' | 'unbound' | 'declined' | 'refused-activation' | 'refused-rate';

let forwardedDepth = 0;

/**
 * True while a handler runs for a key forwarded from a proxied page. Such a key is not a gesture in GNOME's own UI
 * (a forged `tab.key` needs no activation for ordinary actions), so nothing it starts may prompt for the sign-in or
 * the access code (ENGINE-PROTOCOL §1.2 rule 9): `home` with an address as home page opens it like a link, without
 * the interactive ticket mint a navigation typed into the address bar gets.
 */
export function isForwardedDispatch(): boolean {
  return forwardedDepth > 0;
}

let forwardedBuckets = new TokenBuckets(4);
let forwardedListener: ((outcome: ForwardedOutcome, action: ShortcutAction | null) => void) | null = null;

/** The browser counts refused privileged shortcuts (diagnostics, ENGINE-PROTOCOL §1.2 rule 8). */
export function onForwardedShortcut(fn: ((outcome: ForwardedOutcome, action: ShortcutAction | null) => void) | null): void {
  forwardedListener = fn;
}

/** The app document's own transient activation (null where the browser lacks navigator.userActivation). */
function appActivation(): boolean | null {
  const ua = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return ua ? ua.isActive : null;
}

export interface ForwardOptions {
  /** Test seam: the app document's transient activation (defaults to navigator.userActivation.isActive). */
  activation?: () => boolean | null;
  now?: number;
}

/**
 * A key forwarded from the engine host (a validated `tab.key` of the active tab while the browser view is visible;
 * the caller checks those). Runs the shortcut bound to exactly this combo, like a key pressed in the shell, except
 * that privileged actions also need the app document's transient activation (a real key press in the frame gives
 * it: activation propagates to ancestor documents, verified in both browsers by tests/e2e/engine/suites/
 * shell-activation.mjs) and pass FORWARDED_PRIVILEGED_LIMIT (2 at once, then 1 per second). Returns whether an
 * action ran.
 */
export function dispatchForwardedShortcut(combo: string, repeat: boolean, opts: ForwardOptions = {}): boolean {
  const canonical = normalizeCombo(combo);
  const b = canonical ? bindings().find((x) => normalizeCombo(x.raw) === canonical) : undefined;
  if (!b) {
    forwardedListener?.('unbound', null);
    return false;
  }
  if (isPrivilegedForwarded(b.action)) {
    if ((opts.activation ?? appActivation)() !== true) {
      forwardedListener?.('refused-activation', b.action);
      return false;
    }
    if (!forwardedBuckets.take('privileged', FORWARDED_PRIVILEGED_LIMIT, opts.now ?? Date.now())) {
      forwardedListener?.('refused-rate', b.action);
      return false;
    }
  }
  const r = resolveCombo(b.combo, isApplePlatform());
  const ev: KeyEventLike = { key: r.key, ctrlKey: r.ctrl, altKey: r.alt, shiftKey: r.shift, metaKey: r.meta, repeat };
  const stack = handlers.get(b.action);
  for (let i = (stack?.length ?? 0) - 1; i >= 0; i--) {
    const entry = stack?.[i];
    if (!entry || (repeat && !entry.repeat)) continue;
    forwardedDepth++;
    try {
      if (entry.handler(ev) !== false) {
        forwardedListener?.('ran', b.action);
        return true;
      }
    } catch (err) {
      console.error(`[gnome] forwarded shortcut "${b.action}" failed`, err);
      return true;
    } finally {
      forwardedDepth--;
    }
  }
  forwardedListener?.('declined', b.action);
  return false;
}

/** Tests: a fresh privileged-shortcut budget. */
export function resetForwardedBudget(): void {
  forwardedBuckets = new TokenBuckets(4);
}

// ── Helpers for the Settings → Shortcuts editor ──────────────────────────────────────────────────────────────────

/** Records a key press as a combo string (null for lone modifiers). */
export function recordCombo(ev: KeyEventLike): string | null {
  return comboFromEvent(ev, isApplePlatform());
}

/** Other actions already using `combo`. */
export function conflictsFor(combo: string, except?: ShortcutAction): ShortcutAction[] {
  if (!combo) return [];
  const apple = isApplePlatform();
  const map = settings.value.browser.shortcuts;
  return SHORTCUT_ACTIONS.filter((a) => a !== except && map[a] && sameCombo(map[a], combo, apple));
}

/** True when the browser keeps this combo for itself (works only in fullscreen / installed app windows). */
export function isReservedCombo(combo: string): boolean {
  const apple = isApplePlatform();
  return RESERVED_COMBOS.some((r) => sameCombo(r, combo, apple));
}

export const SHORTCUT_LABELS: Readonly<Record<ShortcutAction, string>> = {
  newTab: 'New tab',
  closeTab: 'Close tab',
  reopenClosedTab: 'Reopen closed tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  focusOmnibox: 'Focus address bar',
  reload: 'Reload',
  // A second reload binding (Alt+Shift+R, for the habit of a hard reload). It runs the same `tab.reload`: GNOME has no
  // cache of its own to bypass, and no test shows that a plain reload already skips every cache (ENGINE-PROTOCOL §3:
  // proxied responses come from the transport, not the HTTP cache, by construction), so the label claims nothing more.
  hardReload: 'Reload (second shortcut)',
  back: 'Back',
  forward: 'Forward',
  home: 'Home page',
  bookmarkPage: 'Bookmark this page',
  toggleFullscreen: 'Toggle fullscreen',
  findInPage: 'Find in page',
  openHistory: 'Open history',
  openBookmarks: 'Open bookmarks',
  openDownloads: 'Open downloads',
  openSettings: 'Open settings',
  openGames: 'Open games',
  toggleSidebar: 'Toggle sidebar',
  commandPalette: 'Command palette',
  duplicateTab: 'Duplicate tab',
  pinTab: 'Pin or unpin tab',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  zoomReset: 'Reset zoom',
  selectTab1: 'Go to tab 1',
  selectTab2: 'Go to tab 2',
  selectTab3: 'Go to tab 3',
  selectTab4: 'Go to tab 4',
  selectTab5: 'Go to tab 5',
  selectTab6: 'Go to tab 6',
  selectTab7: 'Go to tab 7',
  selectTab8: 'Go to tab 8',
  selectTab9: 'Go to last tab',
};
