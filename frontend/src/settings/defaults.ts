import type { Settings, ShortcutAction } from './schema';

/**
 * Default keyboard shortcuts. Every default must be capturable by a normal web page, so none of them use the
 * combinations browsers reserve for themselves (see RESERVED_COMBOS). Alt-based combos are used for browser actions;
 * `Mod` means ⌘ on Apple platforms and Ctrl elsewhere. Combos are matched by physical key when Alt is held, so
 * macOS Option-letter characters (Option+T = "†") still trigger them.
 */
export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, string>> = {
  newTab: 'Alt+T',
  closeTab: 'Alt+W',
  reopenClosedTab: 'Alt+Shift+T',
  nextTab: 'Alt+PageDown',
  prevTab: 'Alt+PageUp',
  focusOmnibox: 'Alt+L',
  reload: 'Alt+R',
  hardReload: 'Alt+Shift+R',
  back: 'Alt+ArrowLeft',
  forward: 'Alt+ArrowRight',
  home: 'Alt+Home',
  bookmarkPage: 'Alt+B',
  toggleFullscreen: 'Alt+Shift+F',
  findInPage: 'Mod+F',
  openHistory: 'Alt+H',
  openBookmarks: 'Alt+Shift+B',
  openDownloads: 'Alt+J',
  openSettings: 'Alt+,',
  openGames: 'Alt+G',
  toggleSidebar: 'Alt+S',
  commandPalette: 'Mod+K',
  duplicateTab: 'Alt+Shift+D',
  pinTab: 'Alt+Shift+P',
  zoomIn: 'Alt+=',
  zoomOut: 'Alt+-',
  zoomReset: 'Alt+0',
  selectTab1: 'Alt+1',
  selectTab2: 'Alt+2',
  selectTab3: 'Alt+3',
  selectTab4: 'Alt+4',
  selectTab5: 'Alt+5',
  selectTab6: 'Alt+6',
  selectTab7: 'Alt+7',
  selectTab8: 'Alt+8',
  selectTab9: 'Alt+9',
};

/**
 * Combinations the browser keeps for itself in a normal window: a web page never receives them, so binding one only
 * works while GNOME is in fullscreen with Keyboard Lock or running as an installed web app window (where browsers do
 * not reserve tab/window shortcuts). The settings UI warns when the user picks one of these.
 * Sources: Chromium BrowserCommandController::IsReservedCommandOrKey; Firefox reserved <key> elements.
 */
export const RESERVED_COMBOS: readonly string[] = [
  'Ctrl+T',
  'Ctrl+W',
  'Ctrl+N',
  'Ctrl+Shift+N',
  'Ctrl+Shift+T',
  'Ctrl+Shift+W',
  'Ctrl+Tab',
  'Ctrl+Shift+Tab',
  'Ctrl+PageUp',
  'Ctrl+PageDown',
  'Ctrl+F4',
  'Ctrl+Shift+Q',
  'Meta+T',
  'Meta+W',
  'Meta+N',
  'Meta+Shift+N',
  'Meta+Shift+T',
  'Meta+Q',
  'Alt+F4',
  'Alt+Tab',
];

export const SEARCH_ENGINES: Readonly<
  Record<Exclude<Settings['browser']['searchEngine'], 'custom'>, { label: string; template: string }>
> = {
  duckduckgo: { label: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  google: { label: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { label: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  brave: { label: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  startpage: { label: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { label: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
};

export function createDefaultSettings(): Settings {
  return {
    version: 2,
    appearance: {
      theme: 'dark',
      accentPreset: 'mint',
      accent: '#9ff0c8',
      colors: { background: null, surface: null, text: null, mutedText: null, border: null },
      fontFamily: 'inter',
      fontSize: 14,
      density: 'comfortable',
      transparency: 0.82,
      reduceTransparency: false,
      blur: 16,
      animation: 'normal',
      radius: 10,
      sidebar: 'compact',
      sidebarPosition: 'left',
      toolbar: 'full',
      tabStrip: 'top',
      showBookmarksBar: false,
      // The built-in wallpaper (src/styles/wallpapers.ts); dim and blur apply when the user picks a color, gradient
      // or image, so they keep the values a picture needs.
      homeBackground: { kind: 'wallpaper', value: 'grove', dim: 0.35, blur: 0 },
    },
    browser: {
      searchEngine: 'duckduckgo',
      customSearchUrl: '',
      searchSuggestions: false,
      engine: 'auto',
      autoFallback: true,
      transport: 'libcurl',
      wispServers: [],
      homepage: 'gnome://home',
      startup: 'home',
      startupUrls: [],
      newTab: 'home',
      newTabUrl: '',
      openLinksInBackground: false,
      closeTabActivates: 'right',
      confirmCloseMultiple: true,
      history: { enabled: true, retentionDays: 90 },
      cookies: { mode: 'block-third-party', clearOnExit: false },
      downloads: { track: true, openPanelOnStart: true, keepDays: 30 },
      shortcuts: { ...DEFAULT_SHORTCUTS },
      defaultZoom: 1,
    },
    privacy: {
      webrtc: 'block',
      stripTrackingParams: true,
      sendGpc: true,
      doNotTrack: false,
      referrer: 'origin-cross-site',
      clearHistoryOnExit: false,
      clearSiteDataOnExit: false,
      sitePermissions: {},
      defaultPermissions: {
        camera: 'ask',
        microphone: 'ask',
        geolocation: 'ask',
        notifications: 'block',
        popups: 'block',
        autoplay: 'allow',
        clipboard: 'ask',
        fullscreen: 'allow',
      },
    },
    performance: {
      gpuEffects: true,
      memorySaver: false,
      discardAfterMinutes: 30,
      backgroundTabs: 'keep-alive',
      prefetchPages: true,
      cacheLimitMB: 256,
    },
    vpn: {
      mode: 'off',
      preferredLocation: null,
      autoConnect: false,
      killSwitch: true,
      verifyExit: true,
    },
    games: {
      view: 'grid',
      cardSize: 'medium',
      defaultSort: 'popular',
      fullscreenOnPlay: false,
      trackRecent: true,
      recentLimit: 50,
      showMobileOnly: false,
      hiddenCategories: [],
    },
    extensions: {
      enabled: { adblock: true, trackers: true, privacy: true, cookies: true, cosmetic: true },
      lists: {},
      allowlist: [],
      perSite: {},
      cosmeticAggressive: false,
      autoUpdateLists: true,
      cookieRules: {},
    },
    account: { sync: false, syncHistory: false, syncBookmarks: true, syncSettings: true },
  };
}

/** Immutable reference copy (do not mutate; use createDefaultSettings() for a fresh object). */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze(createDefaultSettings());
