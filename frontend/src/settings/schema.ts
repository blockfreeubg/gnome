/**
 * Settings schema — the contract in docs/ARCHITECTURE.md §5.3. Keep both in sync: every key must be consumed by
 * real behaviour, and the Settings page must not expose anything that does nothing.
 */

export type Theme = 'dark' | 'light' | 'system';
export type Motion = 'none' | 'reduced' | 'normal' | 'expressive';
export type EngineId = 'scramjet' | 'ultraviolet';
export type ShortcutAction =
  | 'newTab'
  | 'closeTab'
  | 'reopenClosedTab'
  | 'nextTab'
  | 'prevTab'
  | 'focusOmnibox'
  | 'reload'
  | 'hardReload'
  | 'back'
  | 'forward'
  | 'home'
  | 'bookmarkPage'
  | 'toggleFullscreen'
  | 'findInPage'
  | 'openHistory'
  | 'openBookmarks'
  | 'openDownloads'
  | 'openSettings'
  | 'openGames'
  | 'toggleSidebar'
  | 'commandPalette'
  | 'duplicateTab'
  | 'pinTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | `selectTab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type AccentPreset =
  | 'mint'
  | 'periwinkle'
  | 'wheat'
  | 'moss'
  | 'lichen'
  | 'ember'
  | 'slate'
  | 'mushroom'
  | 'fern'
  | 'custom';
export type SitePermission =
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'notifications'
  | 'popups'
  | 'autoplay'
  | 'clipboard'
  | 'fullscreen';
export type PermissionValue = 'ask' | 'allow' | 'block';

export interface Settings {
  version: 2;
  appearance: {
    theme: Theme;
    accentPreset: AccentPreset; // default 'mint'
    accent: string; // hex; used when accentPreset === 'custom'
    colors: {
      background: string | null;
      surface: string | null;
      text: string | null;
      mutedText: string | null;
      border: string | null;
    };
    fontFamily: 'inter' | 'montserrat' | 'geist' | 'system' | 'atkinson' | 'fraunces' | 'mono'; // default 'inter'
    fontSize: number; // 12–20 px, default 14
    density: 'compact' | 'comfortable' | 'spacious';
    transparency: number; // 0.55–1 glass opacity, default 0.82
    reduceTransparency: boolean;
    blur: number; // 0–40 px, default 16
    animation: Motion; // default 'normal' (respects prefers-reduced-motion when 'normal')
    radius: number; // 0–16 px, default 10
    sidebar: 'auto' | 'expanded' | 'compact' | 'hidden'; // default 'compact'
    sidebarPosition: 'left' | 'right';
    toolbar: 'full' | 'compact';
    tabStrip: 'top' | 'hidden-when-single';
    showBookmarksBar: boolean;
    homeBackground: {
      kind: 'wallpaper' | 'glow' | 'none' | 'color' | 'gradient' | 'image'; // default 'wallpaper'
      value: string; // wallpaper id, hex color, CSS gradient, https: address or idb:<key>
      dim: number; // 0–0.9 (color, gradient and image)
      blur: number; // 0–40 px (color, gradient and image)
    };
  };
  browser: {
    searchEngine: 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia' | 'custom';
    customSearchUrl: string; // must contain %s
    searchSuggestions: boolean; // fetched through the proxy transport, never via GNOME's server
    engine: 'auto' | EngineId; // 'auto' = Scramjet with controlled fallback to Ultraviolet
    autoFallback: boolean; // one automatic retry on the other engine per navigation
    transport: 'libcurl' | 'epoxy';
    wispServers: string[]; // [] = server default (/wisp/)
    homepage: string; // 'gnome://home' or a URL
    startup: 'home' | 'restore' | 'urls';
    startupUrls: string[];
    newTab: 'home' | 'blank' | 'url';
    newTabUrl: string;
    openLinksInBackground: boolean;
    closeTabActivates: 'right' | 'left' | 'last-used';
    confirmCloseMultiple: boolean;
    history: { enabled: boolean; retentionDays: number /* 0 = forever */ };
    cookies: { mode: 'all' | 'block-third-party' | 'block-all'; clearOnExit: boolean };
    downloads: { track: boolean; openPanelOnStart: boolean; keepDays: number };
    shortcuts: Record<ShortcutAction, string>; // e.g. 'Alt+T'; '' = unbound
    defaultZoom: number; // 0.5–2
  };
  privacy: {
    webrtc: 'block' | 'allow'; // default 'block'; 'allow' sends WebRTC traffic directly, outside GNOME (reveals the IP address)
    stripTrackingParams: boolean;
    sendGpc: boolean; // Sec-GPC: 1
    doNotTrack: boolean;
    referrer: 'default' | 'origin-cross-site' | 'none';
    clearHistoryOnExit: boolean;
    clearSiteDataOnExit: boolean;
    sitePermissions: Record<string /* host */, Partial<Record<SitePermission, PermissionValue>>>;
    defaultPermissions: Record<SitePermission, PermissionValue>;
  };
  performance: {
    gpuEffects: boolean; // blur/backdrop/shadows; off = flat surfaces
    memorySaver: boolean;
    discardAfterMinutes: number; // background tab discard when memorySaver on
    backgroundTabs: 'keep-alive' | 'discard';
    prefetchPages: boolean;
    cacheLimitMB: number; // app/asset cache cap
  };
  vpn: {
    mode: 'off' | 'gateway';
    preferredLocation: string | null; // gateway profile id
    autoConnect: boolean;
    killSwitch: boolean; // if the gateway is down, block proxied traffic instead of going direct
    verifyExit: boolean; // check exit IP via the proxy path
  };
  games: {
    view: 'grid' | 'list';
    cardSize: 'small' | 'medium' | 'large';
    defaultSort: 'popular' | 'trending' | 'new' | 'az';
    fullscreenOnPlay: boolean;
    trackRecent: boolean;
    recentLimit: number;
    showMobileOnly: boolean;
    hiddenCategories: string[];
  };
  extensions: {
    enabled: { adblock: boolean; trackers: boolean; privacy: boolean; cookies: boolean; cosmetic: boolean };
    lists: Record<string /* filter list id */, boolean>;
    allowlist: string[]; // hostnames where all blocking is off
    perSite: Record<string /* host */, { adblock?: boolean; trackers?: boolean; cosmetic?: boolean }>;
    cosmeticAggressive: boolean; // also apply generic cosmetic filters
    autoUpdateLists: boolean;
    cookieRules: Record<string /* host */, 'allow' | 'session' | 'block'>;
  };
  account: { sync: boolean; syncHistory: boolean; syncBookmarks: boolean; syncSettings: boolean };
}

/** Top-level sections (everything except `version`). */
export type SettingsSection = Exclude<keyof Settings, 'version'>;

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'appearance',
  'browser',
  'privacy',
  'performance',
  'vpn',
  'games',
  'extensions',
  'account',
];

export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'newTab',
  'closeTab',
  'reopenClosedTab',
  'nextTab',
  'prevTab',
  'focusOmnibox',
  'reload',
  'hardReload',
  'back',
  'forward',
  'home',
  'bookmarkPage',
  'toggleFullscreen',
  'findInPage',
  'openHistory',
  'openBookmarks',
  'openDownloads',
  'openSettings',
  'openGames',
  'toggleSidebar',
  'commandPalette',
  'duplicateTab',
  'pinTab',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'selectTab1',
  'selectTab2',
  'selectTab3',
  'selectTab4',
  'selectTab5',
  'selectTab6',
  'selectTab7',
  'selectTab8',
  'selectTab9',
];

export const SITE_PERMISSIONS: readonly SitePermission[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'popups',
  'autoplay',
  'clipboard',
  'fullscreen',
];

export const CURRENT_SETTINGS_VERSION = 2 as const;
