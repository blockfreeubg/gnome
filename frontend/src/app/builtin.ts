/**
 * Shell-level shortcut handlers and command-palette commands. Feature teams register their own (tabs, zoom, …);
 * handlers registered later take precedence and may return false to fall back to these.
 */
import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
import FileDown from '@lucide/svelte/icons/file-down';
import FileUp from '@lucide/svelte/icons/file-up';
import Monitor from '@lucide/svelte/icons/monitor';
import Moon from '@lucide/svelte/icons/moon';
import PanelLeft from '@lucide/svelte/icons/panel-left';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Sun from '@lucide/svelte/icons/sun';
import { openInput } from '../browser/bridge';
import { Disposables } from '../lib/events';
import type { Settings } from '../settings/schema';
import { settings } from '../settings/store.svelte';
import { registerCommands } from './commands';
import { confirm } from './overlays/dialogs.svelte';
import { toast } from './overlays/toast.svelte';
import { navigate } from './router.svelte';
import { server } from './server.svelte';
import { shell } from './shell.svelte';
import { register } from './shortcuts';
import { statusSnapshot } from './status';

/** toggleSidebar: reveal/hide the overlay rail in "hidden" mode, otherwise switch expanded ⇄ compact. */
export function toggleSidebar(): void {
  if (settings.value.appearance.sidebar === 'hidden') {
    shell.railOverlay = !shell.railOverlay;
    return;
  }
  settings.set('appearance', 'sidebar', shell.railMode === 'expanded' ? 'compact' : 'expanded');
}

/**
 * home: opens the home page from Settings → Browser (`browser.homepage`): a gnome:// page as a route, an address in
 * the browser view.
 */
export function openHomepage(): void {
  const home = settings.value.browser.homepage;
  if (home && home !== 'gnome://home' && openInput(home)) return;
  void navigate('/');
}

export function exportSettingsFile(): void {
  const blob = new Blob([settings.export()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gnome-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast.success('Settings exported', { description: a.download });
}

export function importSettingsFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast.error('Could not import settings', { description: 'The file is larger than 1 MB.' });
      return;
    }
    const result = settings.import(await file.text());
    if (result.ok) {
      toast.success('Settings imported', {
        description: result.issues.length
          ? `${result.issues.length} value${result.issues.length === 1 ? ' was' : 's were'} invalid and kept at the default.`
          : undefined,
      });
    } else {
      toast.error('Could not import settings', { description: result.error });
    }
  };
  input.click();
}

export async function copyDiagnostics(): Promise<void> {
  const cfg = server.config;
  const info = {
    app: 'GNOME',
    version: __GNOME_VERSION__,
    time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
    server: cfg ? { version: cfg.version, access_mode: cfg.access_mode, features: cfg.features } : null,
    status: statusSnapshot(),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
    toast.success('Diagnostics copied', { description: 'Contains versions and subsystem status only — no browsing data.' });
  } catch {
    toast.error('Could not copy diagnostics', { description: 'Clipboard access was denied by the browser.' });
  }
}

const THEMES: ReadonlyArray<{ value: Settings['appearance']['theme']; title: string; icon: typeof Sun }> = [
  { value: 'dark', title: 'Dark theme', icon: Moon },
  { value: 'light', title: 'Light theme', icon: Sun },
  { value: 'system', title: 'Match system theme', icon: Monitor },
];

const SIDEBAR_MODES: ReadonlyArray<{ value: Settings['appearance']['sidebar']; title: string }> = [
  { value: 'auto', title: 'Sidebar: automatic' },
  { value: 'expanded', title: 'Sidebar: expanded' },
  { value: 'compact', title: 'Sidebar: compact' },
  { value: 'hidden', title: 'Sidebar: hidden' },
];

export function registerBuiltins(): () => void {
  const d = new Disposables();

  // Shortcuts owned by the shell.
  d.add(register('commandPalette', () => shell.togglePalette()));
  d.add(register('toggleSidebar', () => toggleSidebar()));
  d.add(register('openSettings', () => void navigate('/settings')));
  d.add(register('openHistory', () => void navigate('/history')));
  d.add(register('openBookmarks', () => void navigate('/bookmarks')));
  d.add(register('openDownloads', () => void navigate('/downloads')));
  d.add(register('openGames', () => void navigate('/games')));
  d.add(register('home', () => openHomepage()));

  d.add(
    registerCommands([
      ...THEMES.map((t) => ({
        id: `theme.${t.value}`,
        title: t.title,
        group: 'Appearance',
        icon: t.icon,
        keywords: ['theme', 'appearance', 'mode', t.value],
        checked: () => settings.value.appearance.theme === t.value,
        run: () => void settings.set('appearance', 'theme', t.value),
      })),
      {
        id: 'sidebar.toggle',
        title: 'Toggle sidebar',
        group: 'Appearance',
        icon: PanelLeft,
        shortcut: 'toggleSidebar',
        keywords: ['rail', 'navigation', 'collapse', 'expand'],
        run: toggleSidebar,
      },
      ...SIDEBAR_MODES.map((m) => ({
        id: `sidebar.${m.value}`,
        title: m.title,
        group: 'Appearance',
        icon: PanelLeft,
        keywords: ['rail', 'navigation', m.value],
        checked: () => settings.value.appearance.sidebar === m.value,
        run: () => {
          shell.railOverlay = false;
          settings.set('appearance', 'sidebar', m.value);
        },
      })),
      {
        id: 'sidebar.side',
        title: 'Move sidebar to the other side',
        group: 'Appearance',
        icon: ArrowLeftRight,
        keywords: ['rail', 'left', 'right', 'position'],
        run: () =>
          void settings.set('appearance', 'sidebarPosition', settings.value.appearance.sidebarPosition === 'left' ? 'right' : 'left'),
      },
      {
        id: 'appearance.reset',
        title: 'Reset appearance settings',
        group: 'Appearance',
        icon: RotateCcw,
        keywords: ['defaults', 'theme', 'colors'],
        run: async () => {
          const ok = await confirm({
            title: 'Reset appearance?',
            message: 'Theme, colors, fonts, density, radius and sidebar return to their defaults. Other settings are kept.',
            confirmLabel: 'Reset',
            danger: true,
          });
          if (ok) {
            settings.reset('appearance');
            toast.success('Appearance reset to defaults');
          }
        },
      },
      {
        id: 'settings.export',
        title: 'Export settings',
        subtitle: 'Download your settings as a JSON file',
        group: 'Settings',
        icon: FileDown,
        keywords: ['backup', 'save', 'json'],
        run: exportSettingsFile,
      },
      {
        id: 'settings.import',
        title: 'Import settings',
        subtitle: 'Load settings from a GNOME export',
        group: 'Settings',
        icon: FileUp,
        keywords: ['restore', 'load', 'json'],
        run: importSettingsFile,
      },
      {
        id: 'app.diagnostics',
        title: 'Copy diagnostics',
        subtitle: 'Versions and subsystem status for bug reports',
        group: 'GNOME',
        icon: ClipboardCopy,
        keywords: ['debug', 'status', 'support'],
        run: copyDiagnostics,
      },
      {
        id: 'app.reload',
        title: 'Reload GNOME',
        group: 'GNOME',
        icon: RefreshCw,
        keywords: ['refresh', 'restart'],
        run: () => location.reload(),
      },
    ]),
  );

  return () => d.dispose();
}
