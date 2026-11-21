/**
 * Command registry for the command palette (Ctrl/⌘+K). Features register commands while they are available:
 *
 *   const off = registerCommand({ id: 'tabs.duplicate', title: 'Duplicate tab', group: 'Tabs',
 *     shortcut: 'duplicateTab', run: () => tabs.duplicate() });
 *
 * Navigation entries are generated from the route registry; commands only cover actions.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { LucideIcon } from '@lucide/svelte';
import type { ShortcutAction } from '../settings/schema';

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  /** Palette section, e.g. "Appearance", "Tabs". */
  group: string;
  keywords?: string[];
  icon?: LucideIcon;
  /** ShortcutAction name (shows the user's binding) or a literal combo. */
  shortcut?: ShortcutAction | string;
  /** Only listed while this returns true (read reactively). */
  when?: () => boolean;
  /** Shows a check mark (e.g. the current theme). */
  checked?: () => boolean;
  run: () => void | Promise<void>;
}

const registry = new SvelteMap<string, Command>();

export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd);
  return () => {
    if (registry.get(cmd.id) === cmd) registry.delete(cmd.id);
  };
}

export function registerCommands(cmds: readonly Command[]): () => void {
  const offs = cmds.map(registerCommand);
  return () => offs.forEach((off) => off());
}

/** Available commands (reactive). */
export function listCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.when || c.when());
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id);
}

// ── Recently used (local only) ──────────────────────────────────────────────────────────────────────────────────

const RECENT_KEY = 'gnome:palette:recent';
const RECENT_MAX = 6;

export function recentIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function markUsed(id: string): void {
  try {
    const next = [id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
