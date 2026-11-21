/**
 * Settings page registry: the sections of /settings and every row in them, with the words search matches against.
 * Rows name the settings paths they edit, which drives "reset to default" per row and per section. Pure data +
 * functions (unit-tested in search.test.ts).
 */
import { SHORTCUT_LABELS } from '../../app/shortcuts';
import { createDefaultSettings } from '../../settings/defaults';
import { isFeatureActive, SHELL_SHORTCUTS, type Feature } from '../../settings/features';
import { SHORTCUT_ACTIONS, type Settings, type SettingsSection } from '../../settings/schema';

export type SectionId =
  | 'appearance'
  | 'browser'
  | 'privacy'
  | 'performance'
  | 'vpn'
  | 'games'
  | 'extensions'
  | 'shortcuts'
  | 'account'
  | 'advanced';

export interface SectionMeta {
  id: SectionId;
  label: string;
  description: string;
  /** Description while some of the section's rows are hidden (their feature is not in this build). */
  core?: string;
  keywords?: string;
}

export const SECTIONS: readonly SectionMeta[] = [
  { id: 'appearance', label: 'Appearance', description: 'Theme, accent, fonts, density, glass and layout.' },
  { id: 'browser', label: 'Browser', description: 'Search, start-up, tabs, history and downloads.', core: 'Search engine and home page.' },
  {
    id: 'privacy',
    label: 'Privacy',
    description: 'Tracking protection, cookies, permissions and clearing data.',
    core: 'Clearing the data GNOME keeps in this browser.',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Effects, memory saver, prefetching and cache size.',
    core: 'Visual effects and preloading GNOME’s pages.',
  },
  { id: 'vpn', label: 'VPN', description: 'Route pages opened in GNOME through a VPN gateway.' },
  { id: 'games', label: 'Games', description: 'Catalog layout, sorting, recently played and categories.' },
  { id: 'extensions', label: 'Extensions', description: 'Ad and tracker blocking, filter lists and site rules.' },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    description: 'Keyboard shortcuts for tabs, navigation and pages.',
    core: 'Keyboard shortcuts for GNOME’s pages and sidebar.',
  },
  {
    id: 'account',
    label: 'Account & sync',
    description: 'Sign in to sync settings and bookmarks between browsers.',
    core: 'Sign in to sync your settings between browsers.',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    description: 'Proxy engine, transport, Wisp servers and diagnostics.',
    core: 'Proxy isolation, diagnostics, import and export.',
  },
];

export const SECTION_IDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));

export function isSectionId(v: string | undefined | null): v is SectionId {
  return !!v && SECTION_IDS.has(v);
}

export interface RowMeta {
  section: SectionId;
  /** Anchor inside the section: /settings/<section>#<id>. */
  id: string;
  label: string;
  description?: string;
  /** Extra words people may search for. */
  keywords?: string;
  /** Settings paths this row edits ("appearance.theme", "browser.history.enabled"). */
  paths: readonly string[];
  /**
   * The feature that acts on this setting (settings/features.ts). Until it registers, the row is hidden: Settings
   * never offers a control that does nothing. Rows without `needs` work in every build.
   */
  needs?: Feature;
}

type RowInput = Omit<RowMeta, 'section' | 'paths'> & { paths?: readonly string[] };

function rows(section: SectionId, list: readonly RowInput[], needs?: Feature): RowMeta[] {
  return list.map((r) => {
    const row: RowMeta = { ...r, section, paths: r.paths ?? [] };
    if (needs && !r.needs) row.needs = needs;
    return row;
  });
}

const A = (k: string): string => `appearance.${k}`;
const B = (k: string): string => `browser.${k}`;
const P = (k: string): string => `privacy.${k}`;

export const ROWS: readonly RowMeta[] = [
  ...rows('appearance', [
    { id: 'theme', label: 'Theme', description: 'Dark, light, or follow your device.', keywords: 'dark mode light mode color scheme night', paths: [A('theme')] },
    { id: 'accent', label: 'Accent color', description: 'Used for focus rings, selection and highlights.', keywords: 'colour mint periwinkle wheat moss custom hex', paths: [A('accentPreset'), A('accent')] },
    { id: 'colors', label: 'Custom colors', description: 'Override the background, surface, text and border colors of the theme.', keywords: 'colour palette background text border surface override', paths: [A('colors')] },
    { id: 'fontFamily', label: 'Interface font', description: 'The typeface used across GNOME.', keywords: 'typeface inter montserrat geist atkinson fraunces mono serif', paths: [A('fontFamily')] },
    { id: 'fontSize', label: 'Text size', description: 'Base size for interface text.', keywords: 'font size zoom bigger smaller scale', paths: [A('fontSize')] },
    { id: 'density', label: 'Density', description: 'How much space controls and lists use.', keywords: 'compact comfortable spacious padding', paths: [A('density')] },
    { id: 'radius', label: 'Corner radius', description: 'Roundness of buttons, fields and panels.', keywords: 'rounded corners border radius square', paths: [A('radius')] },
    { id: 'animation', label: 'Animation', description: 'Normal follows your device’s reduced-motion preference.', keywords: 'motion reduce transitions effects', paths: [A('animation')] },
    { id: 'transparency', label: 'Glass opacity', description: 'Opacity of floating menus, toolbars and popovers.', keywords: 'transparency translucent glass', paths: [A('transparency')] },
    { id: 'blur', label: 'Background blur', description: 'Blur behind translucent surfaces. 0 makes them opaque.', keywords: 'glass frosted backdrop', paths: [A('blur')] },
    { id: 'reduceTransparency', label: 'Reduce transparency', description: 'Use solid surfaces everywhere.', keywords: 'opaque glass accessibility contrast', paths: [A('reduceTransparency')] },
    { id: 'sidebar', label: 'Sidebar', description: 'Automatic is compact while browsing and expanded elsewhere on wide screens.', keywords: 'rail navigation collapse expand hide', paths: [A('sidebar')] },
    { id: 'sidebarPosition', label: 'Sidebar position', keywords: 'rail left right side', paths: [A('sidebarPosition')] },
    { id: 'toolbar', needs: 'browser', label: 'Browser toolbar', description: 'Full shows every button; compact keeps navigation, the address bar and the menu.', keywords: 'toolbar buttons address bar', paths: [A('toolbar')] },
    { id: 'tabStrip', needs: 'browser', label: 'Tab strip', description: 'Hide the tab strip while only one tab is open.', keywords: 'tabs bar', paths: [A('tabStrip')] },
    { id: 'showBookmarksBar', needs: 'browser', label: 'Bookmarks bar', description: 'Show bookmarks under the address bar.', keywords: 'favorites toolbar', paths: [A('showBookmarksBar')] },
    { id: 'homeBackground', label: 'Home background', description: 'The backdrop of the Home page.', keywords: 'wallpaper image gradient glow picture', paths: [A('homeBackground')] },
  ]),
  ...rows('browser', [
    { id: 'searchEngine', label: 'Search engine', description: 'Used when what you search for is not a web address.', keywords: 'duckduckgo google bing brave startpage ecosia omnibox', paths: [B('searchEngine')] },
    { id: 'customSearchUrl', label: 'Custom search URL', description: 'An http(s) address with %s where the search terms go.', keywords: 'search template query', paths: [B('customSearchUrl')] },
    { id: 'searchSuggestions', needs: 'browser', label: 'Search suggestions', description: 'Ask the search engine for suggestions while you type. Requests go through the proxy, never through the GNOME server.', keywords: 'autocomplete omnibox', paths: [B('searchSuggestions')] },
    { id: 'homepage', label: 'Home page', description: 'Opened by the Home shortcut.', keywords: 'start page homepage url', paths: [B('homepage')] },
    { id: 'startup', needs: 'browser', label: 'On start-up', description: 'What the browser shows when GNOME opens.', keywords: 'startup launch restore session tabs', paths: [B('startup')] },
    { id: 'startupUrls', needs: 'browser', label: 'Start-up pages', description: 'Opened in tabs when GNOME starts.', keywords: 'startup urls pages', paths: [B('startupUrls')] },
    { id: 'newTab', needs: 'browser', label: 'New tabs open', keywords: 'new tab page blank', paths: [B('newTab')] },
    { id: 'newTabUrl', needs: 'browser', label: 'New tab address', keywords: 'new tab url', paths: [B('newTabUrl')] },
    { id: 'openLinksInBackground', needs: 'browser', label: 'Open links in the background', description: 'Links opened in a new tab do not take focus.', keywords: 'tabs background focus', paths: [B('openLinksInBackground')] },
    { id: 'closeTabActivates', needs: 'browser', label: 'After closing a tab', description: 'Which tab becomes active.', keywords: 'close tab focus next', paths: [B('closeTabActivates')] },
    { id: 'confirmCloseMultiple', needs: 'browser', label: 'Confirm before closing several tabs', keywords: 'close tabs warning ask', paths: [B('confirmCloseMultiple')] },
    { id: 'defaultZoom', needs: 'browser', label: 'Default zoom', description: 'Zoom level for pages without their own.', keywords: 'zoom scale page size', paths: [B('defaultZoom')] },
    { id: 'history', needs: 'browser', label: 'Save browsing history', description: 'History stays in this browser unless you turn on history sync.', keywords: 'history record visits', paths: [B('history.enabled')] },
    { id: 'historyRetention', needs: 'browser', label: 'Keep history for', keywords: 'history retention delete old days', paths: [B('history.retentionDays')] },
    { id: 'downloadsTrack', needs: 'browser', label: 'Keep a downloads list', keywords: 'downloads list record', paths: [B('downloads.track')] },
    { id: 'downloadsPanel', needs: 'browser', label: 'Show downloads when one starts', keywords: 'downloads panel open', paths: [B('downloads.openPanelOnStart')] },
    { id: 'downloadsKeep', needs: 'browser', label: 'Keep finished downloads in the list for', keywords: 'downloads retention days', paths: [B('downloads.keepDays')] },
  ]),
  ...rows('privacy', [
    { id: 'clearData', label: 'Clear browsing data', description: 'Remove history, site data, cached files, the downloads list or closed tabs.', keywords: 'delete erase wipe cookies cache history' },
    { id: 'stripTrackingParams', needs: 'extensions', label: 'Remove tracking parameters', description: 'Removes utm_*, fbclid, gclid and similar from pages you open.', keywords: 'utm fbclid gclid url clean', paths: [P('stripTrackingParams')] },
    { id: 'sendGpc', needs: 'extensions', label: 'Send Global Privacy Control', description: 'Tells sites not to sell or share your data (Sec-GPC: 1). Legally binding in some regions.', keywords: 'gpc do not sell', paths: [P('sendGpc')] },
    { id: 'doNotTrack', needs: 'extensions', label: 'Send Do Not Track', description: 'A request most sites ignore; it also makes you slightly easier to fingerprint.', keywords: 'dnt header', paths: [P('doNotTrack')] },
    { id: 'referrer', needs: 'extensions', label: 'Referrer', description: 'What a site learns about the page that linked to it.', keywords: 'referer header origin', paths: [P('referrer')] },
    { id: 'cookies', needs: 'extensions', label: 'Cookies', description: 'Applies to sites opened in GNOME’s browser.', keywords: 'third-party cookies block', paths: [B('cookies.mode')] },
    { id: 'cookiesClearOnExit', needs: 'browser', label: 'Clear cookies when GNOME closes', description: 'Cookies of sites opened in GNOME are removed the next time GNOME starts in a new browser tab.', keywords: 'cookies delete exit', paths: [B('cookies.clearOnExit')] },
    { id: 'clearHistoryOnExit', needs: 'browser', label: 'Clear history when GNOME closes', description: 'Applied the next time GNOME starts in a new browser tab, when no other GNOME tab is open.', keywords: 'history delete exit', paths: [P('clearHistoryOnExit')] },
    { id: 'clearSiteDataOnExit', needs: 'browser', label: 'Clear site data when GNOME closes', description: 'Cookies, storage and cached files of sites opened in GNOME, removed the next time GNOME starts in a new browser tab.', keywords: 'storage cookies delete exit', paths: [P('clearSiteDataOnExit')] },
    { id: 'webrtc', needs: 'browser', label: 'WebRTC', description: 'Video calls and other peer-to-peer connections. Allowing them sends that traffic directly, outside GNOME, and reveals your IP address to the sites you use them with. Blocking stops sites that use WebRTC in the usual way; a site built to get around the block can still reveal your IP address. Always blocked while the VPN kill switch is on.', keywords: 'webrtc ip leak stun peer video call rtc', paths: [P('webrtc')] },
    { id: 'defaultPermissions', needs: 'browser', label: 'Default permissions', description: 'What sites opened in GNOME may do unless you decide otherwise for a site. Applies to pages you open in GNOME (address bar, links from GNOME, reload, back and forward).', keywords: 'camera microphone location notifications popups autoplay clipboard fullscreen', paths: [P('defaultPermissions')] },
    { id: 'sitePermissions', needs: 'browser', label: 'Site permissions', description: 'Exceptions for individual sites.', keywords: 'per-site allow block camera microphone location', paths: [P('sitePermissions')] },
  ]),
  ...rows('performance', [
    { id: 'gpuEffects', label: 'GPU-heavy effects', description: 'Blur, translucency and shadows. Turn off on slow devices for flat, opaque surfaces.', keywords: 'blur shadows gpu battery', paths: ['performance.gpuEffects'] },
    { id: 'memorySaver', needs: 'browser', label: 'Memory saver', description: 'Unload background tabs you have not used for a while; they reload when you return.', keywords: 'ram memory discard tabs', paths: ['performance.memorySaver'] },
    { id: 'discardAfterMinutes', needs: 'browser', label: 'Unload tabs after', keywords: 'memory discard minutes', paths: ['performance.discardAfterMinutes'] },
    { id: 'backgroundTabs', needs: 'browser', label: 'Background tabs', description: 'Keep background tabs running, or unload them as soon as you switch away.', keywords: 'tabs discard keep alive', paths: ['performance.backgroundTabs'] },
    { id: 'prefetchPages', label: 'Preload GNOME pages', description: 'Load a page’s code when you point at its link, so it opens instantly.', keywords: 'prefetch preload speed', paths: ['performance.prefetchPages'] },
    { id: 'cacheLimitMB', needs: 'extensions', label: 'Filter data cache limit', description: 'Maximum space for the filter-list data GNOME’s blockers cache in this browser.', keywords: 'cache storage disk size filter lists', paths: ['performance.cacheLimitMB'] },
  ]),
  ...rows('vpn', [
    { id: 'mode', label: 'VPN gateway', description: 'Route pages opened in GNOME through a VPN gateway run by this server.', keywords: 'vpn mullvad wireguard tunnel gateway', paths: ['vpn.mode'] },
    { id: 'preferredLocation', label: 'Location', description: 'The gateway pages are routed through.', keywords: 'country city server location exit', paths: ['vpn.preferredLocation'] },
    { id: 'autoConnect', label: 'Connect automatically', description: 'Use the gateway as soon as GNOME opens.', keywords: 'auto connect start', paths: ['vpn.autoConnect'] },
    { id: 'killSwitch', label: 'Block if the gateway is down', description: 'Stop loading pages instead of falling back to the server’s own connection.', keywords: 'kill switch leak protection', paths: ['vpn.killSwitch'] },
    { id: 'verifyExit', label: 'Verify the exit address', description: 'Check from this browser, through the gateway, which IP address sites see.', keywords: 'ip check exit verify', paths: ['vpn.verifyExit'] },
  ], 'vpn'),
  ...rows('games', [
    { id: 'view', label: 'Catalog view', keywords: 'grid list layout', paths: ['games.view'] },
    { id: 'cardSize', label: 'Card size', keywords: 'thumbnail size tiles', paths: ['games.cardSize'] },
    { id: 'defaultSort', label: 'Default sort', keywords: 'order popular trending new alphabetical', paths: ['games.defaultSort'] },
    { id: 'fullscreenOnPlay', label: 'Start games in fullscreen', keywords: 'fullscreen play', paths: ['games.fullscreenOnPlay'] },
    { id: 'trackRecent', label: 'Remember recently played', description: 'Kept in this browser only.', keywords: 'recent history played', paths: ['games.trackRecent'] },
    { id: 'recentLimit', label: 'Recently played to keep', keywords: 'recent count', paths: ['games.recentLimit'] },
    { id: 'showMobileOnly', label: 'Only games that work on touch screens', keywords: 'mobile touch phone tablet', paths: ['games.showMobileOnly'] },
    { id: 'hiddenCategories', label: 'Hidden categories', description: 'Games in these categories are left out of the catalog.', keywords: 'hide categories filter genres', paths: ['games.hiddenCategories'] },
  ], 'games'),
  ...rows('extensions', [
    { id: 'adblock', label: 'Ad blocker', description: 'Blocks requests to ad servers, and pages on the scam and malware list, on sites you open in GNOME.', keywords: 'ads adblock ublock block', paths: ['extensions.enabled.adblock'] },
    { id: 'trackers', label: 'Tracker blocker', description: 'Blocks requests to tracking and analytics servers on sites you open in GNOME.', keywords: 'tracking analytics privacy', paths: ['extensions.enabled.trackers'] },
    { id: 'privacy', label: 'Privacy protection', description: 'Sends Global Privacy Control, trims referrers and strips tracking parameters as set under Privacy.', keywords: 'gpc referrer fingerprint', paths: ['extensions.enabled.privacy'] },
    { id: 'cookieManager', label: 'Cookie manager', description: 'Applies the cookie rules below and the cookie settings under Privacy.', keywords: 'cookies rules', paths: ['extensions.enabled.cookies'] },
    { id: 'cosmetic', label: 'Cosmetic filtering', description: 'Hides ad frames and page clutter, and applies cookie-notice and annoyance lists.', keywords: 'element hiding css annoyances', paths: ['extensions.enabled.cosmetic'] },
    { id: 'cosmeticAggressive', label: 'Generic cosmetic filters', description: 'Also apply site-independent hiding rules. Blocks more, occasionally hides real content.', keywords: 'aggressive generic hiding', paths: ['extensions.cosmeticAggressive'] },
    { id: 'autoUpdateLists', label: 'Update filter lists automatically', description: 'When off, GNOME keeps the lists it has until you update them. If this browser’s cache was cleared, it downloads the current versions.', keywords: 'update lists refresh', paths: ['extensions.autoUpdateLists'] },
    { id: 'lists', label: 'Filter lists', description: 'Lists are mirrored by this server from their publishers.', keywords: 'easylist easyprivacy ublock filters subscriptions', paths: ['extensions.lists'] },
    { id: 'allowlist', label: 'Allowed sites', description: 'Ad and tracker blocking, the scam and malware list, cosmetic filtering and tracking-parameter removal are off on these sites and their subdomains. Privacy headers and cookie rules still apply.', keywords: 'whitelist allowlist exceptions disable', paths: ['extensions.allowlist'] },
    { id: 'perSite', label: 'Per-site overrides', description: 'Turn the ad blocker (with the scam and malware list), the tracker blocker or cosmetic filtering on or off for one site and its subdomains.', keywords: 'site exceptions override', paths: ['extensions.perSite'] },
    { id: 'cookieRules', label: 'Cookie rules', description: 'Applies to a site’s cookies wherever they are used, also inside other sites. “Until GNOME closes” also ends the cookies of its subdomains.', keywords: 'cookies allow block session site', paths: ['extensions.cookieRules'] },
  ], 'extensions'),
  ...rows(
    'shortcuts',
    SHORTCUT_ACTIONS.map((a) => ({
      id: a,
      label: SHORTCUT_LABELS[a],
      keywords: 'keyboard shortcut key binding hotkey',
      paths: [B(`shortcuts.${a}`)],
      ...(SHELL_SHORTCUTS.has(a) ? {} : { needs: 'browser' as const }),
    })),
  ),
  ...rows('account', [
    { id: 'account', label: 'Account', description: 'Sign in, create an account, change your password or delete your account.', keywords: 'login sign in register sign up logout password delete user' },
    { id: 'sync', label: 'Sync', description: 'Keep a copy on this server and in your other browsers.', keywords: 'sync cloud backup devices', paths: ['account.sync'] },
    { id: 'syncSettings', label: 'Sync settings', keywords: 'sync preferences', paths: ['account.syncSettings'] },
    { id: 'syncBookmarks', needs: 'browser', label: 'Sync bookmarks', keywords: 'sync favorites', paths: ['account.syncBookmarks'] },
    { id: 'syncHistory', needs: 'browser', label: 'Sync history', description: 'Sends the addresses you visit to this server. Off by default.', keywords: 'sync history visits', paths: ['account.syncHistory'] },
  ]),
  ...rows('advanced', [
    { id: 'engine', needs: 'browser', label: 'Proxy engine', description: 'Automatic follows this server’s default: usually Scramjet, retried with Ultraviolet when a page fails.', keywords: 'scramjet ultraviolet uv engine rewriter fallback', paths: [B('engine')] },
    { id: 'autoFallback', needs: 'browser', label: 'Retry on the other engine', description: 'When a page fails to load, try it once with the other engine.', keywords: 'fallback retry engine', paths: [B('autoFallback')] },
    { id: 'transport', needs: 'browser', label: 'Transport', description: 'How the engines reach the Wisp server.', keywords: 'libcurl epoxy tls transport', paths: [B('transport')] },
    { id: 'wispServers', needs: 'browser', label: 'Custom Wisp servers', description: 'Use other Wisp servers instead of this GNOME server’s gateway, when the server allows it.', keywords: 'wisp websocket server ws wss custom', paths: [B('wispServers')] },
    { id: 'isolation', label: 'Proxy isolation', description: 'Whether proxied pages run on a separate origin from GNOME.', keywords: 'origin isolation security single-origin' },
    { id: 'diagnostics', label: 'Diagnostics', description: 'Versions and subsystem status, without browsing data.', keywords: 'debug status support copy' },
    { id: 'importExport', label: 'Import and export', description: 'Save your settings to a JSON file, or load them from one. Sync switches stay as they are in this browser.', keywords: 'backup json file transfer' },
    { id: 'resetAll', label: 'Reset all settings', description: 'Every setting goes back to its default. Sync switches and your data are not touched.', keywords: 'defaults factory restore' },
  ]),
];

export const ROW_BY_KEY: ReadonlyMap<string, RowMeta> = new Map(ROWS.map((r) => [`${r.section}.${r.id}`, r]));

export function rowsOf(section: SectionId): RowMeta[] {
  return ROWS.filter((r) => r.section === section);
}

/** Whether a row's setting is acted on in this build (its feature, if any, has registered). Reactive. */
export function rowActive(row: RowMeta, active: (f: Feature) => boolean = isFeatureActive): boolean {
  return !row.needs || active(row.needs);
}

/** Rows of a section that are shown in this build. */
export function activeRowsOf(section: SectionId, active: (f: Feature) => boolean = isFeatureActive): RowMeta[] {
  return rowsOf(section).filter((r) => rowActive(r, active));
}

export function sectionOf(id: SectionId): SectionMeta {
  return SECTIONS.find((s) => s.id === id)!;
}

/** A section's description for this build: `core` while some of its rows are hidden. Reactive. */
export function sectionDescription(id: SectionId, active: (f: Feature) => boolean = isFeatureActive): string {
  const s = sectionOf(id);
  return s.core && activeRowsOf(id, active).length < rowsOf(id).length ? s.core : s.description;
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Returns a copy of `root` with `path` set (objects along the path are copied, never mutated). */
export function withAt<T>(root: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const obj = (root && typeof root === 'object' ? root : {}) as Record<string, unknown>;
  if (!head) return root;
  return { ...obj, [head]: rest.length ? withAt(obj[head], rest.join('.'), value) : value } as T;
}

const DEFAULTS = createDefaultSettings();

export function defaultAt(path: string): unknown {
  return getAt(DEFAULTS, path);
}

/** The schema section and top-level key a path belongs to. */
export function splitPath(path: string): { section: SettingsSection; key: string; rest: string } {
  const [section, key, ...rest] = path.split('.');
  return { section: section as SettingsSection, key: key ?? '', rest: rest.join('.') };
}

/** Builds the new section object for a set of path → value changes (used by setPaths). */
export function applyPaths(current: Settings, changes: ReadonlyArray<readonly [string, unknown]>): Settings {
  let next = current;
  for (const [path, value] of changes) next = withAt(next, path, value);
  return next;
}

// ── Search ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, "'");
}

export function queryTerms(query: string): string[] {
  return [...new Set(normalizeText(query).split(/[\s,]+/).filter((t) => t.length > 0))].slice(0, 8);
}

export interface SearchHit {
  row: RowMeta;
  score: number;
}

function wordStart(text: string, term: string): boolean {
  const i = text.indexOf(term);
  return i === 0 || (i > 0 && /[\s\-(/]/.test(text[i - 1]!));
}

/**
 * Rows matching every term (in the label, description, keywords or section name), best first: label matches
 * outrank keyword matches, which outrank description matches; word starts beat substrings. Rows hidden in this build
 * (see `needs`) are never results.
 */
export function searchSettings(query: string, active: (f: Feature) => boolean = isFeatureActive): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  ROWS.forEach((row, order) => {
    if (!rowActive(row, active)) return;
    const label = normalizeText(row.label);
    const desc = normalizeText(row.description ?? '');
    const kw = normalizeText(row.keywords ?? '');
    const sectionLabel = normalizeText(sectionOf(row.section).label);
    let score = 0;
    for (const t of terms) {
      let s = 0;
      if (label.startsWith(t)) s = 100;
      else if (wordStart(label, t)) s = 80;
      else if (label.includes(t)) s = 60;
      else if (wordStart(kw, t)) s = 45;
      else if (kw.includes(t)) s = 35;
      else if (wordStart(desc, t)) s = 25;
      else if (desc.includes(t)) s = 15;
      else if (sectionLabel.includes(t)) s = 10;
      if (!s) return;
      score += s;
    }
    hits.push({ row, score: score - order / 10_000 });
  });
  return hits.sort((a, b) => b.score - a.score);
}

/** [start, end) ranges of every term occurrence in `text` (case/diacritic-insensitive), merged and sorted. */
export function matchRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!terms.length || !text) return [];
  // NFKD can change lengths; only map when the normalized text keeps 1:1 positions.
  const lower = text.toLowerCase();
  const norm = normalizeText(text);
  const hay = norm.length === text.length ? norm : lower;
  const ranges: Array<[number, number]> = [];
  for (const t of terms) {
    if (!t) continue;
    let i = hay.indexOf(t);
    while (i >= 0) {
      ranges.push([i, i + t.length]);
      i = hay.indexOf(t, i + t.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
