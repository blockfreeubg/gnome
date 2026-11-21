/**
 * Keyboard shortcut reference for the About page: every ShortcutAction, grouped, with the user's current binding.
 * Pure (bindings and platform are parameters) so it can be unit-tested; the page passes settings.value.browser.shortcuts.
 */
import { formatCombo, describeCombo, parseCombo } from '../../lib/keys';
import { SHORTCUT_LABELS } from '../../app/shortcuts';
import { SHORTCUT_ACTIONS, type ShortcutAction } from '../../settings/schema';

export interface ShortcutRow {
  /** Stable key for keyed lists. */
  id: string;
  label: string;
  actions: readonly ShortcutAction[];
  /** Key caps of the binding ([] when unbound). */
  caps: string[];
  /** For a range row ("Go to tab 1–8"): caps of the last binding of the range. */
  capsEnd?: string[];
  /** Spoken form for screen readers ("Alt+1 to Alt+8"); '' when unbound. */
  spoken: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  rows: ShortcutRow[];
}

/** Display grouping. Every action appears exactly once (tested). */
export const SHORTCUT_GROUPS: ReadonlyArray<{ id: string; title: string; actions: readonly ShortcutAction[] }> = [
  {
    id: 'general',
    title: 'General',
    actions: ['commandPalette', 'toggleSidebar', 'openSettings', 'openHistory', 'openBookmarks', 'openDownloads', 'openGames'],
  },
  {
    id: 'page',
    title: 'Pages',
    actions: [
      'focusOmnibox',
      'back',
      'forward',
      'reload',
      'hardReload',
      'home',
      'findInPage',
      'bookmarkPage',
      'zoomIn',
      'zoomOut',
      'zoomReset',
      'toggleFullscreen',
    ],
  },
  {
    id: 'tabs',
    title: 'Tabs',
    actions: [
      'newTab',
      'closeTab',
      'reopenClosedTab',
      'duplicateTab',
      'pinTab',
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
    ],
  },
];

const TAB_RANGE: readonly ShortcutAction[] = [
  'selectTab1',
  'selectTab2',
  'selectTab3',
  'selectTab4',
  'selectTab5',
  'selectTab6',
  'selectTab7',
  'selectTab8',
];

/**
 * True when "Go to tab 1…8" are bound to the same modifiers with the digits 1…8, so one row can show them as a
 * range. Any custom deviation lists the eight actions individually.
 */
export function isDigitRange(bindings: readonly string[]): boolean {
  if (bindings.length !== 8) return false;
  const parsed = bindings.map((b) => (b ? parseCombo(b) : null));
  const first = parsed[0];
  if (!first) return false;
  return parsed.every(
    (c, i) =>
      c !== null &&
      c.key === String(i + 1) &&
      c.mod === first.mod &&
      c.ctrl === first.ctrl &&
      c.meta === first.meta &&
      c.alt === first.alt &&
      c.shift === first.shift,
  );
}

function row(action: ShortcutAction, combo: string, apple: boolean): ShortcutRow {
  return {
    id: action,
    label: SHORTCUT_LABELS[action],
    actions: [action],
    caps: combo ? formatCombo(combo, apple) : [],
    spoken: combo ? describeCombo(combo, apple) : '',
  };
}

/**
 * Groups of rows for the current bindings. `include` leaves out actions that do nothing in this build (their feature
 * is not present); groups left empty are dropped.
 */
export function shortcutReference(
  bindings: Readonly<Partial<Record<ShortcutAction, string>>>,
  apple: boolean,
  include: (action: ShortcutAction) => boolean = () => true,
): ShortcutGroup[] {
  const combo = (a: ShortcutAction): string => bindings[a] ?? '';
  const groups = SHORTCUT_GROUPS.map((g) => {
    const rows: ShortcutRow[] = [];
    const rangeBindings = TAB_RANGE.map(combo);
    const collapseRange = g.actions.includes('selectTab1') && TAB_RANGE.every(include) && isDigitRange(rangeBindings);
    for (const action of g.actions) {
      if (!include(action)) continue;
      if (collapseRange && TAB_RANGE.includes(action)) {
        if (action !== 'selectTab1') continue;
        const first = rangeBindings[0] ?? '';
        const last = rangeBindings[7] ?? '';
        rows.push({
          id: 'selectTab1-8',
          label: 'Go to tab 1–8',
          actions: TAB_RANGE,
          caps: formatCombo(first, apple),
          capsEnd: formatCombo(last, apple),
          spoken: `${describeCombo(first, apple)} to ${describeCombo(last, apple)}`,
        });
        continue;
      }
      rows.push(row(action, combo(action), apple));
    }
    return { id: g.id, title: g.title, rows };
  });
  return groups.filter((g) => g.rows.length > 0);
}

/** Actions missing from SHORTCUT_GROUPS or listed twice (empty when the grouping is complete). */
export function groupingProblems(): string[] {
  const seen = new Map<ShortcutAction, number>();
  for (const g of SHORTCUT_GROUPS) for (const a of g.actions) seen.set(a, (seen.get(a) ?? 0) + 1);
  const problems: string[] = [];
  for (const a of SHORTCUT_ACTIONS) {
    const n = seen.get(a) ?? 0;
    if (n !== 1) problems.push(`${a} listed ${n} times`);
  }
  for (const a of seen.keys()) if (!SHORTCUT_ACTIONS.includes(a)) problems.push(`${a} is not a shortcut action`);
  return problems;
}
