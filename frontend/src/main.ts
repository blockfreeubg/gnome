/**
 * Entry point. Order matters: settings load synchronously from the localStorage mirror (the inline boot script
 * already painted the right theme), the appearance engine takes over, then the shell mounts and the router
 * resolves the first page. Network work (server config) never blocks the UI.
 */
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/utilities.css';

import { mount } from 'svelte';
import App from './app/App.svelte';
import { registerBuiltins } from './app/builtin';
import { prompt } from './app/overlays/dialogs.svelte';
import { toast } from './app/overlays/toast.svelte';
import { router } from './app/router.svelte';
import { server } from './app/server.svelte';
import { installShortcutListener } from './app/shortcuts';
import { reportStatus } from './app/status';
import { setAccessCodePrompt } from './lib/api';
import { appEvents } from './lib/events';
import { onDatabaseState } from './lib/idb';
import { onIdle } from './lib/platform';
import { loadTldList } from './lib/url';
import { initAccount } from './settings/account.svelte';
import { startAppearanceEngine } from './settings/appearance.svelte';
import { releaseReplacedPictures } from './settings/local-picture';
import { settings } from './settings/store.svelte';

onDatabaseState((state, detail) => {
  reportStatus('storage', {
    state: state === 'ok' ? 'ok' : state === 'blocked' ? 'degraded' : 'down',
    detail: state === 'ok' ? 'IndexedDB available' : detail,
  });
});

void settings.init();
startAppearanceEngine();
releaseReplacedPictures(settings);
installShortcutListener();
registerBuiltins();

setAccessCodePrompt(async ({ submit }) => {
  const code = await prompt({
    title: 'Access code required',
    message: 'This GNOME server is private. Enter the access code you were given to use the browser.',
    label: 'Access code',
    placeholder: 'Your access code',
    inputType: 'password',
    confirmLabel: 'Continue',
    autocomplete: 'current-password',
    validate: (v) => (v.trim() ? null : 'Enter the access code.'),
    submit,
  });
  return code !== null;
});

appEvents.on('session:login-required', ({ message }) => {
  toast.warning('Sign-in required', { description: message || 'This server only allows signed-in users.' });
});

const target = document.getElementById('app');
if (!target) throw new Error('#app element missing');
mount(App, { target });

void router.init();
void server.refresh();
// Who is signed in (asks the server only when this browser was signed in last time). Sync is not needed for the
// first paint: its controller loads once the page is idle.
initAccount();
onIdle(() => void import('./settings/account-sync').then((m) => m.startAccountSync()));
onIdle(() => void loadTldList());
// The browser library (history, bookmarks, downloads: src/library) and the browser itself (tabs, the BrowserBridge,
// shortcuts; src/browser). The engine iframe is created only when the browser view first needs a proxied tab.
// The library loads on idle, not in the startup bundle (about 11 KB gzip): everything that reads it handles a late
// registration (library()/onLibrary(); its sync adapters announce themselves), its pages and the browser view call
// the idempotent initLibrary() themselves, and Home falls back to its direct IndexedDB reads until then.
onIdle(() => void import('./library').then((m) => m.initLibrary()));
onIdle(() => void import('./browser/browser.svelte').then((m) => m.startBrowser()));
// Games (src/games): registers 'games' while the server offers a catalog, and the "Recently played games" clearer.
onIdle(() => void import('./games/start').then((m) => m.startGames()));
// VPN (src/vpn): location and exit status, the tab-strip chip (docs/WAVE-C.md §7). Auto-connect is not here: the
// browser decides it in its own start, before any tab loads (§8.1).
onIdle(() => void import('./vpn/start').then((m) => m.startVpn()));
