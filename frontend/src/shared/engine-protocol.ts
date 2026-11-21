/**
 * GNOME engine protocol v1: the contract between the app (the SPA on the app origin) and the engine host
 * (`<proxy origin>/engine/`, ARCHITECTURE §4.6). This file is the source of truth; docs/ENGINE-PROTOCOL.md explains
 * it, including what the two-origin spike proved and what it did not.
 *
 * Imported by the app bundle and by the engine-host bundle. It has no runtime dependencies and no side effects at
 * import time (every top-level value is a literal, a function, or a pure-annotated construction), so each bundle
 * keeps only what it uses. Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).
 *
 * Trust model, in one paragraph: the app origin is the boundary GNOME guarantees. The proxy origin is one shared
 * realm, so a proxied page that escapes its engine controls the engine host, the port and everything sent over it.
 * The app therefore validates every event and every command result with the validators below, renders strings as
 * text, rate-limits per tab (EVENT_RATE_LIMITS) and asks for a gesture in its own UI before any privileged action.
 * Everything the app sends may be read by such a page: never send account data, history, bookmarks, the session
 * cookie or anything else that is not listed in the types below.
 *
 * Validation rules (both directions): structural violations reject the whole message (wrong type, missing key,
 * unknown enum value, NaN/Infinity or out-of-range number, oversized string/array/record, a URL that is not
 * absolute http(s) where one is required, `__proto__`/`constructor`/`prototype` keys, accessor properties, objects
 * that are not plain). Cosmetic normalization never rejects: unknown keys are dropped, display text loses control
 * and bidi-override characters (lone surrogates become U+FFFD), URLs are re-serialized by the URL parser with any
 * credentials removed. Sizes count UTF-16 code units. Because the validators reject rather than clamp, the engine
 * host fits what it measures before emitting: text cut to its LIMITS with fitText(), numbers rounded and clamped with
 * fitInt() (coordinates, durations), and it coalesces latest-value events (COALESCE_MS).
 */

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bumped on every incompatible change. A mismatch makes both sides show "GNOME was updated — reload". */
export const PROTOCOL_VERSION = 1;

export type EngineId = 'scramjet' | 'ultraviolet';
export const ENGINE_IDS: readonly EngineId[] = ['scramjet', 'ultraviolet'];

/** Same transport family for both engines (Scramjet: libcurl 2.0.6 / epoxy 3.0.2; UV: libcurl 1.5.2 / epoxy 2.1.29). */
export type TransportKind = 'libcurl' | 'epoxy';
export const TRANSPORT_KINDS: readonly TransportKind[] = ['libcurl', 'epoxy'];

/** Integer 1..LIMITS.maxTabId, chosen by the app, unique per engine-host instance (never reused within one). */
export type TabId = number;
/** Integer ≥ 1, chosen by the engine host, unique per engine-host instance. */
export type NavId = number;

// ── Limits, timeouts, policies ───────────────────────────────────────────────────────────────────────────────────

export const LIMITS = {
  maxTabId: 2_147_483_647,
  /** Live tab frames one engine host keeps (tab.create beyond it fails with `too_many_tabs`). */
  maxLiveTabs: 32,
  /**
   * App: beyond this many live proxied tabs, discard the least recently used background tab (never the active or a
   * pinned one). Scramjet rewrites on the renderer thread the shell shares (ARCHITECTURE §5.4).
   */
  liveTabsSoftCap: 16,
  /**
   * App: GNOME tabs in one app page (internal and proxied, live or discarded). Creating one more is refused with a
   * notice: a forged `tab.key` or `tab.openRequest` must not grow the tab list without bound.
   */
  maxTabs: 500,
  maxUrlLength: 8192,
  maxWsUrlLength: 2048,
  maxTitleLength: 1024,
  maxDetailLength: 300,
  maxMessageLength: 500,
  /** Selection text in tab.contextMenu; longer selections are cut (`selectionTruncated`) and the app offers no Copy. */
  maxSelectionLength: 100_000,
  maxFilenameLength: 255,
  /** Decoded favicon bytes; the data: URL may be at most FAVICON_MAX_CHARS long. */
  faviconMaxBytes: 65_536,
  maxFindQuery: 512,
  /** tab.find stops collecting after this many matches (`capped: true`). */
  findMaxMatches: 1000,
  maxSuggestQuery: 256,
  maxSuggestions: 10,
  maxSuggestionLength: 256,
  maxCombos: 64,
  /** Canonical src/lib/keys.ts combos are at most 35 characters ("Mod+Ctrl+Meta+Alt+Shift+ContextMenu"). */
  maxComboLength: 48,
  /** Entries of one host-keyed record (the blocker's per-site and cookie rules) and of its allowlist. */
  maxSiteRules: 5000,
  maxHostKeyLength: 260,
  maxFilterLists: 500,
  maxWispServers: 16,
  /**
   * Entries of a tab's back/forward list: the engine host keeps at most this many per tab (dropping the oldest, like
   * browsers do), reports them in tab.committed (`index`, `length`) and tab.state, and accepts as many on restore.
   */
  maxTabHistory: 50,
  maxGoDelta: 50,
  zoomMin: 0.25,
  zoomMax: 5,
  maxCookies: 5000,
  maxCookieNameLength: 256,
  maxCookiePathLength: 1024,
  maxTicketLength: 512,
  /** Keys of one structured object (records have their own cap). */
  maxObjectKeys: 64,
  maxDiagnosticsDirectives: 32,
  /** Largest integer timing (ms) any message carries. */
  maxDurationMs: 3_600_000,
} as const;

/** `data:image/vnd.microsoft.icon;base64,` (the longest allowed prefix) + base64 of faviconMaxBytes. */
export const FAVICON_MAX_CHARS = 'data:image/vnd.microsoft.icon;base64,'.length + Math.ceil(65_536 / 3) * 4;

export const TIMEOUTS = {
  /** Engine host: repeat `hello` this often until `connect` arrives… */
  helloIntervalMs: 500,
  /** …for at most this long. */
  helloRepeatForMs: 15_000,
  /**
   * App: no valid hello this long after it created the engine iframe → "the browser engine did not start" (with
   * Retry). The app keeps expecting the hello: a late one from the same iframe still connects (HelloContext.expecting;
   * src/browser/engine/client.ts still ends the window at this timeout until integration part 2, ENGINE-PROTOCOL §2.2).
   */
  helloWaitMs: 20_000,
  /** App: default command timeout (navigation commands resolve when the navigation has started). */
  commandMs: 10_000,
  initMs: 40_000,
  ticketMs: 30_000,
  statusMs: 5_000,
  pingMs: 5_000,
  /** App: liveness ping while the browser view is visible. */
  pingIntervalMs: 30_000,
  diagnosticsMs: 5_000,
  findMs: 5_000,
  suggestMs: 5_000,
  cookiesMs: 10_000,
  siteDataMs: 30_000,
  vpnVerifyMs: 20_000,
  /** Engine host: a navigation without a document after this long fails with signal `timeout`. */
  navigationMs: 20_000,
  /**
   * Engine host: a navigation answered with a type browsers do not render (proxy-origin.ts downloadDisposition
   * `unrendered-type`) that commits no document within this long is reported as a download.
   */
  downloadCommitMs: 2_000,
  /**
   * App: a navigation that started (tab.loading true, or a navigation command resolved) and got neither tab.loaded
   * nor tab.error after this long makes the app ask `tab.state` (a dropped or lost event must not leave a spinner).
   */
  navigationWatchdogMs: 25_000,
  /** App: events for a tab it closed less than this long ago were in flight: dropped without being counted. */
  closedTabGraceMs: 10_000,
} as const;

/** Wisp tickets (API.md `POST /api/wisp/ticket`; ARCHITECTURE §4.6). */
export const TICKET = {
  /** Engine host: emit needTicket{expiring} when this fraction of the ticket's remaining life has passed… */
  renewAtFraction: 0.8,
  /**
   * …but never sooner than this after receiving it, even for a ticket that arrived expired: a renewal can then never
   * loop (a ticket that is really dead is caught by the next probe's 401 → needTicket{rejected}).
   */
  minRenewDelayMs: 10_000,
  /** App: subtracted from the life it computes from the response's 1-second `Date` header (ticketExpiresAtLocal). */
  clockMarginMs: 1_000,
  /**
   * App: at most one ticket request per 2 s and 10 per rolling minute (the server allows 30 per minute per session).
   * A needTicket that arrives inside these limits is deferred until they allow it and coalesced with any other
   * pending one, never dropped (with short TTLs a dropped renewal left the transports without a valid ticket).
   */
  appMinIntervalMs: 2_000,
  appMaxPerMinute: 10,
} as const;

export interface RateLimit {
  /** Bucket size (events allowed at once). */
  burst: number;
  /** Refill rate. */
  perSecond: number;
}

// ── Capabilities ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Optional features. The engine host lists the ones it implements in InitResult.capabilities (only those whose e2e
 * test passes in both browsers); the app shows UI only for those, and a command that needs a missing capability fails
 * with `unsupported`. Core features (tabs, navigation, fallback, find, keys, context menus, fullscreen, downloads,
 * popup routing, WebRTC blocking, CSP, tab.state) are not listed: every engine host must implement them. Which
 * site permissions it can enforce is reported separately, per permission (InitResult.enforcedPermissions).
 */
export type Capability =
  | 'zoom'
  | 'print'
  | 'selectAll'
  | 'saveLink'
  | 'saveImage'
  | 'cookies'
  | 'siteData'
  | 'suggest'
  | 'vpnVerify'
  | 'blocker';
export const CAPABILITIES: readonly Capability[] = [
  'zoom',
  'print',
  'selectAll',
  'saveLink',
  'saveImage',
  'cookies',
  'siteData',
  'suggest',
  'vpnVerify',
  'blocker',
];

// ── Settings snapshot (app → engine host) ────────────────────────────────────────────────────────────────────────

/**
 * Where the transports connect. `default` = `/wisp/` on the proxy origin, `profile` = `/wisp/p/<id>/` (a VPN gateway
 * profile from /api/config), `custom` = the user's `browser.wispServers` in order (absolute ws:/wss: URLs or paths on
 * the proxy origin). The app chooses, in this order: `profile` while `vpn.mode` is `gateway` (the VPN always wins:
 * custom servers would bypass it); `custom` only when the operator allows custom servers (`/api/config` →
 * `wisp.custom_servers`, `GNOME_ALLOW_CUSTOM_WISP`; otherwise the engine-host and bare-mux worker CSPs allow no other
 * host); else `default`. The Wisp ticket is appended only to URLs on the proxy origin, never to other servers. The app
 * enforces the VPN kill switch by choosing the route: the engine host never switches routes by itself.
 */
export type WispRoute = { kind: 'default' } | { kind: 'profile'; id: string } | { kind: 'custom'; servers: string[] };

export type PermissionDecision = 'allow' | 'block';
/**
 * Permissions the engine host enforces per destination site (through the tab iframe's `allow` attribute). The app
 * resolves the user's ask/allow/block settings for the destination of every GNOME-initiated load and sends the result
 * with that command (`permissions` of tab.create/navigate/go/reload), so the engine host never receives the user's
 * per-site list. Camera, microphone, geolocation and notifications are never delegated to the engine iframe, so
 * proxied pages cannot use them; popups are decided by the app (`tab.openRequest`).
 */
export type EnginePermission = 'autoplay' | 'fullscreen' | 'clipboard';
export const ENGINE_PERMISSIONS: readonly EnginePermission[] = ['autoplay', 'fullscreen', 'clipboard'];
/** The resolved decisions for one destination (site-rules.ts enginePermissionsFor). */
export type EnginePermissionSet = Record<EnginePermission, PermissionDecision>;

export type FilterCategory = 'ads' | 'privacy' | 'annoyances' | 'cookies' | 'urlparams' | 'security' | 'resources';

/** A filter list the content blocker should load: fetched by the engine host from `/api/filters/<id>?v=<sha256>`. */
export interface FilterListRef {
  id: string;
  sha256: string;
  category: FilterCategory;
  format: 'abp' | 'resources';
  /** The list may use uBO `trusted-*` scriptlets (API.md "FilterList"). */
  trusted: boolean;
}

export interface EngineSettings {
  /** Engines this server offers (`/api/config` → `engines`); a disabled engine is never initialized. */
  engines: Record<EngineId, boolean>;
  /**
   * `auto` = Scramjet first with controlled fallback to Ultraviolet; an engine id forces that engine (no automatic
   * fallback). The app derives it with engineChoice() from `browser.engine`, the server default and `engines`.
   */
  engine: 'auto' | EngineId;
  /** One automatic retry on Ultraviolet per idempotent (GET/HEAD) navigation after a Scramjet engine failure. */
  autoFallback: boolean;
  transport: TransportKind;
  route: WispRoute;
  privacy: {
    /** Core (Wave B step 2): `block` replaces the WebRTC constructors in every proxied window and the engine host. */
    webrtc: 'block' | 'allow';
    /** The rest is applied by the content-blocking runtime (Wave B step 3, capability `blocker`). */
    sendGpc: boolean;
    doNotTrack: boolean;
    referrer: 'default' | 'origin-cross-site' | 'none';
    stripTrackingParams: boolean;
    cookies: 'all' | 'block-third-party' | 'block-all';
  };
  /**
   * Content blocking (Wave B step 3, capability `blocker`). Keys of the records are host keys. `allowlist`, `perSite`
   * and `cookieRules` name every site the user made a rule for, which a hostile page in the engine host can read
   * (ENGINE-PROTOCOL §1.2 rule 4): the app sends them empty until the engine host reported `blocker`.
   */
  extensions: {
    enabled: { adblock: boolean; trackers: boolean; privacy: boolean; cookies: boolean; cosmetic: boolean };
    lists: FilterListRef[];
    allowlist: string[];
    perSite: Record<string, { adblock?: boolean; trackers?: boolean; cosmetic?: boolean }>;
    cosmeticAggressive: boolean;
    cookieRules: Record<string, 'allow' | 'session' | 'block'>;
    /**
     * `performance.cacheLimitMB` (Wave B step 3): the cap on what the content blocker keeps in Cache Storage on the
     * proxy origin, in MiB (16–8192, the settings range). Absent (an older app of the same protocol version) = 256.
     */
    cacheLimitMB?: number;
  };
  /**
   * Shortcut combos the engine host forwards from proxied documents (`tab.key`), in `src/lib/keys.ts` syntax (the
   * bound values of `browser.shortcuts`), plus the platform flag `matchCombo()` needs. The engine host matches with
   * the same `src/lib/keys.ts` functions as the shell, so forwarded keys behave like keys pressed in the shell.
   */
  keys: { combos: string[]; apple: boolean };
}

/** POST /api/wisp/ticket, as the app received it. `wispUrl` is informational: the engine host builds its own URLs. */
export interface Ticket {
  value: string;
  /**
   * Unix ms on this browser's clock, not the server's: the app converts `expires_at` with ticketExpiresAtLocal()
   * (the response's `Date` header), so a device clock that is off does not make every ticket look expired.
   */
  expiresAt: number;
  wispUrl: string;
}

// ── Status (engine host → app) ───────────────────────────────────────────────────────────────────────────────────

export type EngineState = 'initializing' | 'ready' | 'failed' | 'disabled';
export interface EngineStatus {
  state: EngineState;
  version: string;
  /** Why it failed (`failed`), else null. */
  detail: string | null;
}

/**
 * Per engine side (ENGINE-PROTOCOL §6.6):
 * - `connecting`: a transport is being built or rebuilt (`detail` `rebuilding`).
 * - `ready`: the transport is built and nothing is known to be wrong: no socket has failed since the last build, or
 *   the last socket opened. Sockets open on demand (a page's first request opens one), so `ready` does not mean that
 *   a socket is open or that the endpoint answers: an idle side is `ready`, not `connecting`.
 * - `degraded`: a socket dropped or failed to open; recovery (probe, rebuild, failover to a route's next custom
 *   server) is running.
 * - `offline`: no usable transport; `detail` says why.
 */
export type TransportState = 'connecting' | 'ready' | 'degraded' | 'offline';
/**
 * - `ticket-missing`: no ticket yet (init without one). `ticket-rejected`: the probe answered 401.
 * - `gateway-unreachable`: the probe failed at the network level (GNOME's gateway, or a custom server, is down).
 * - `upstream-unreachable`: the gateway's upstream (HolyWisp, or the VPN location's instance) is down: the probe
 *   answered `503 wisp_upstream_unavailable` (the server's health job marked it down), or it answered 426 (ticket
 *   valid; the probe never contacts the upstream) and the socket then failed to open.
 * - `unknown-profile`: the probe answered 404: the route names a VPN profile the server no longer has. The app
 *   refreshes `/api/config` and chooses the route again (kill switch rules apply).
 * - `rate-limited`: the probe answered 429; `retryInMs` says when the next attempt is.
 * - `rebuilding`: a transport is being (re)built. `rebuild-limit`: too many rebuilds in a minute (RECOVERY).
 */
export type TransportDetail =
  | 'ticket-missing'
  | 'ticket-rejected'
  | 'gateway-unreachable'
  | 'upstream-unreachable'
  | 'unknown-profile'
  | 'rate-limited'
  | 'rebuilding'
  | 'rebuild-limit';
export const TRANSPORT_DETAILS: readonly TransportDetail[] = [
  'ticket-missing',
  'ticket-rejected',
  'gateway-unreachable',
  'upstream-unreachable',
  'unknown-profile',
  'rate-limited',
  'rebuilding',
  'rebuild-limit',
];
export type EndpointKind = 'default' | 'profile' | 'custom';
export interface TransportStatus {
  state: TransportState;
  transport: TransportKind;
  endpoint: EndpointKind;
  detail: TransportDetail | null;
  /** Unix ms of the last state change. */
  since: number;
  /** While offline or backing off: ms until the next attempt; else null. */
  retryInMs: number | null;
}

export interface SwStatus {
  controlled: boolean;
  /** Build id the active service worker reports (null when it did not answer). */
  build: string | null;
  /** The active service worker belongs to this engine host's build. */
  current: boolean;
  /** A newer /sw.js is installed and waiting (it is applied when this is the only engine host and it reloads). */
  updateWaiting: boolean;
}

export type BlockerState = 'off' | 'building' | 'ready' | 'failed';
export interface BlockerStatus {
  state: BlockerState;
  /** Lists compiled into the engine. */
  lists: number;
  /**
   * A code, never display text (WAVE-B3 C5b; `src/extensions/core/detail.ts` parses it): `building`/`ready`/`off`
   * null, or `ready` with `lists-failed:<failed>:<total>`, `over-cache-limit:<bytes>:<limitBytes>` or
   * `cache-rejected`; `failed` with `failed:<reason>` (`all-lists-failed`, `worker-crashed`, `out-of-memory`,
   * `build-error`). The app renders its own sentence for each code and a generic one for anything else.
   */
  detail: string | null;
}

/** One filter engine per list group (WAVE-B3 D1); a block by a group is counted as its BlockCategory. */
export type BlockerGroup = 'ads' | 'security' | 'trackers' | 'params' | 'cookies' | 'annoyances';
export const BLOCKER_GROUPS: readonly BlockerGroup[] = ['ads', 'security', 'trackers', 'params', 'cookies', 'annoyances'];

/**
 * Why a list was not compiled (WAVE-B3 D9): the download failed, the server's body no longer has the ref's hash, the
 * list exceeds the size cap, it is not valid UTF-8, or the engine could not be built from it. A code: the app shows
 * its own text (never text the engine host wrote) and takes list names only from its own /api/filters listing.
 */
export type BlockerListError = 'download' | 'changed' | 'too-large' | 'invalid-utf8' | 'build';
export const BLOCKER_LIST_ERRORS: readonly BlockerListError[] = ['download', 'changed', 'too-large', 'invalid-utf8', 'build'];

export interface BlockerListStats {
  id: string;
  /** The ref's SHA-256 (what the app asked for). */
  sha256: string;
  state: 'compiled' | 'failed';
  /** Null when compiled. */
  error: BlockerListError | null;
  /** Filter lines the sanitizer kept, and the ones it removed (scriptlets that need trust in an untrusted list, unsafe scriptlet arguments, unsafe :style(), invalid selectors, unsupported syntax). */
  rules: number;
  dropped: number;
}

export interface BlockerStats {
  /** `ENGINE_VERSION` of @ghostery/adblocker (899 for 2.20.3). */
  engineVersion: number;
  /** Unix ms when the engines in force were built (loaded from the cache: the start of the UTC day); null before the first. */
  builtAt: number | null;
  buildMs: number | null;
  /** Where the engines in force came from: a verified cache entry, or a build by this engine host. */
  source: 'cache' | 'build' | null;
  engines: Array<{ group: BlockerGroup; bytes: number; network: number; cosmetic: number; scriptlets: number }>;
  lists: BlockerListStats[];
  /** GNOME's blocker cache on the proxy origin (Cache Storage), against cacheLimitMB. */
  cache: { bytes: number; entries: number; limitBytes: number };
  /** uBO redirect resources and scriptlets loaded from `ubo-resources`; null without them. */
  resources: { redirects: number; scriptlets: number } | null;
}

export interface EngineHostStatus {
  engines: Record<EngineId, EngineStatus>;
  transport: Record<EngineId, TransportStatus>;
  sw: SwStatus;
  blocker: BlockerStatus;
}

export interface EngineVersions {
  build: string;
  scramjet: string;
  scramjetController: string;
  ultraviolet: string;
  bareMux: string;
  transports: Record<EngineId, Record<TransportKind, string>>;
}

// ── Commands (app → engine host) ─────────────────────────────────────────────────────────────────────────────────

export type Empty = Record<string, never>;

export interface TabRef {
  tabId: TabId;
}

/**
 * How a new tab starts: empty (no frame until navigated), at a URL, or restored with its back/forward entries.
 * `opener` (optional; integration part 2): the real URL of the page that asked for this tab (`tab.openRequest`: a
 * `target=_blank` link, `window.open`, the pop-up indicator). The engine host then loads `url` as a navigation that
 * page started, with that page as its initiator (`Sec-Fetch-Site`, `Origin`, `Referer` and the SameSite cookie rules
 * as a browser applies them to a link), instead of as GNOME's own load, which carries no initiator like a typed URL
 * (ENGINE-PROTOCOL §6.1, §6.3). Without it, a page could send any site a request with its SameSite=Strict cookies.
 */
export type TabStart =
  | { kind: 'blank' }
  | { kind: 'url'; url: string; opener?: string }
  /** Session restore / un-discard: entries are real URLs (never proxied ones); the tab loads entries[index]. */
  | { kind: 'restore'; entries: string[]; index: number };

export interface NavStart {
  navId: NavId;
  engine: EngineId;
}

export interface FindResult {
  matches: number;
  /** 1-based index of the active match, 0 when there is none. */
  active: number;
  /** The CSS Custom Highlight API was available (matches are highlighted). */
  highlights: boolean;
  /** More than LIMITS.findMaxMatches matches: only the first ones are counted and highlighted. */
  capped: boolean;
}

export interface CookieInfo {
  engine: EngineId;
  domain: string;
  path: string;
  name: string;
  /** Length of the value (values never cross the protocol). */
  size: number;
  /** Unix ms, or null for a session cookie. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none' | null;
}

export type SiteDataKind = 'cookies' | 'storage' | 'cache';
export type SuggestProvider = 'duckduckgo' | 'google' | 'bing' | 'brave' | 'startpage' | 'ecosia';
export const SUGGEST_PROVIDERS: readonly SuggestProvider[] = ['duckduckgo', 'google', 'bing', 'brave', 'startpage', 'ecosia'];

/**
 * What the exit check service answered, as the engine host reports it. Not proof: after an escape a page can forge
 * the whole result, so the app shows it as the check service's answer and takes "VPN active" from its own facts
 * (the route it chose and `/api/vpn/locations` on the app origin), never from this (ENGINE-PROTOCOL §6.13).
 */
export interface VpnVerifyResult {
  ip: string;
  country: string | null;
  city: string | null;
  /** The check service says this is a VPN exit (am.i.mullvad.net `mullvad_exit_ip`); null when it does not say. */
  vpnExit: boolean | null;
  /** Unix ms. */
  checkedAt: number;
}

export interface InitResult {
  instance: string;
  status: EngineHostStatus;
  versions: EngineVersions;
  capabilities: Capability[];
  /**
   * The site permissions this engine host enforces in this browser (proven by its e2e test there): the app offers
   * allow/block only for these and treats the others as always allowed, as a normal browser would.
   */
  enforcedPermissions: EnginePermission[];
  timings: { swReadyMs: number; scramjetMs: number | null; ultravioletMs: number | null; totalMs: number };
}

/** What the engine host knows about one tab: the app resynchronizes with it (tab.state). */
export interface TabState {
  /** The tab's back/forward list (real URLs, oldest first, at most LIMITS.maxTabHistory); [] before the first commit. */
  entries: string[];
  /** The current entry (0 while `entries` is empty). */
  index: number;
  title: string | null;
  loading: boolean;
  /** The navigation in progress, else the last one; null before the first. */
  navId: NavId | null;
  /** The engine of the current document or of the navigation in progress; null before the first navigation. */
  engine: EngineId | null;
  /** The tab.error of the last navigation when it failed (the app shows its error overlay), else null. */
  error: EventMap['tab.error'] | null;
}

/** Counters only: no URLs, titles or other browsing data, so "Copy diagnostics" is safe to paste in a bug report. */
export interface EngineDiagnostics {
  instance: string;
  uptimeMs: number;
  status: EngineHostStatus;
  versions: EngineVersions;
  capabilities: Capability[];
  enforcedPermissions: EnginePermission[];
  tabs: { live: number; scramjet: number; ultraviolet: number };
  /** SW (re)starts seen, Scramjet requests held while the controller re-announced, 503 answers (all reasons). */
  sw: { starts: number; held: number; unavailable: number };
  /** Proxied-document CSP violations (blocked direct connections), by effective directive. */
  csp: { violations: number; byDirective: Record<string, number> };
  webrtc: { policy: 'block' | 'allow'; blocked: number };
  transport: {
    probes: { valid: number; rejected: number; unreachable: number; rateLimited: number; upstreamDown: number; unknownProfile: number };
    rebuilds: Record<EngineId, number>;
    drops: Record<EngineId, number>;
  };
  fallback: { switched: number; notRetried: number };
  protocol: { rejectedCommands: number };
  memory: { usedJSHeapSize: number; totalJSHeapSize: number } | null;
  mainThread: { maxLagMs: number; longTasks: number; longTaskMs: number };
  /** Wave B step 3: hook throws caught by the composite and the call sites, WebSocket backstop decisions, announcement waits. */
  blocker?: { hookErrors: number; wsBackstopBlocked: number; wsBackstopSkipped: number; announceWaits: number; announceTimeouts: number };
}

export interface InitPayload {
  settings: EngineSettings;
  /** Null when no ticket could be minted (e.g. sign-in required): transports stay offline with `ticket-missing`. */
  ticket: Ticket | null;
  /** Clear proxied site data before the engines start ("clear on exit" settings, applied at the next start). */
  clearOnStart: { cookies: boolean; siteData: boolean };
  /**
   * Wave B step 3: a random 256-bit key (64 lower-case hex digits) the app keeps in its own storage, never on the proxy
   * origin. The content blocker MACs what it caches on the proxy origin with it and uses cached filter data only when
   * the MAC verifies, so a page that writes the proxy origin's Cache Storage cannot plant filters or scriptlets.
   * The app replaces it when site data is cleared and after a compromise signal (WAVE-B3 D6). Escaped code can read
   * it (ENGINE-PROTOCOL §1). Absent: the blocker caches nothing.
   */
  blockerKey?: string;
}

/** Every command: its payload and its result. */
export interface CommandMap {
  /** Once per port, first. */
  init: { payload: InitPayload; result: InitResult };
  /** Full snapshot (not a patch); the engine host applies what changed. */
  settings: { payload: { settings: EngineSettings }; result: Empty };
  /** Answer to needTicket, or a proactive renewal. */
  ticket: { payload: Ticket; result: Empty };
  status: { payload: Empty; result: EngineHostStatus };
  ping: { payload: Empty; result: { instance: string; uptimeMs: number } };
  diagnostics: { payload: Empty; result: EngineDiagnostics };
  /**
   * `permissions` (on tab.create/navigate/go/reload): the decisions for the destination this command loads
   * (tab.create: the URL or `entries[index]`; tab.go: the target entry of the app's copy; tab.reload: the current
   * URL). The engine host writes them into the tab iframe's `allow` before the load (site-rules.ts tabFrameAllow);
   * in-page navigations keep them until the next GNOME-initiated load.
   */
  'tab.create': {
    payload: { tabId: TabId; active: boolean; engine: EngineId | null; zoom: number; start: TabStart; permissions: EnginePermissionSet };
    result: { navId: NavId | null; engine: EngineId | null };
  };
  'tab.close': { payload: TabRef; result: Empty };
  /** null = no proxied tab visible (the active GNOME tab shows an internal page). */
  'tab.activate': { payload: { tabId: TabId | null }; result: Empty };
  /** `engine` forces an engine (no automatic fallback for this navigation). Resolves when the load started. */
  'tab.navigate': { payload: { tabId: TabId; url: string; engine: EngineId | null; permissions: EnginePermissionSet }; result: NavStart };
  /**
   * Through GNOME's per-tab history (never the frame's own history): a full load of the target entry's URL with
   * `location.replace`, also for entries a page made with pushState. Fails with `no_entry`.
   */
  'tab.go': { payload: { tabId: TabId; delta: number; permissions: EnginePermissionSet }; result: NavStart };
  'tab.reload': { payload: { tabId: TabId; permissions: EnginePermissionSet }; result: NavStart };
  'tab.stop': { payload: TabRef; result: Empty };
  /** Core: what the engine host knows about the tab (after dropped events, the navigation watchdog, on resume). */
  'tab.state': { payload: TabRef; result: TabState };
  /** Capability `zoom`. Per tab, kept across navigations. */
  'tab.zoom': { payload: { tabId: TabId; factor: number }; result: { factor: number } };
  'tab.find': {
    payload: { tabId: TabId; query: string; backwards: boolean; caseSensitive: boolean };
    result: FindResult;
  };
  'tab.findClear': { payload: TabRef; result: Empty };
  /** Capabilities `selectAll` / `print`. */
  'tab.action': { payload: { tabId: TabId; action: 'selectAll' | 'print' }; result: Empty };
  /** Capabilities `saveLink` / `saveImage`: download `url` in the tab's context (reported with download.* events). */
  'tab.download': { payload: { tabId: TabId; url: string; kind: 'link' | 'image' }; result: Empty };
  /** Capability `cookies`. Both engines' jars; `site` filters by domain (the site and its subdomains). */
  'cookies.list': { payload: { site: string | null }; result: { cookies: CookieInfo[]; truncated: boolean } };
  /** Capability `cookies`. `all` ⇒ site and name are null; otherwise site is set (name null = every cookie of it). */
  'cookies.delete': { payload: { all: boolean; site: string | null; name: string | null }; result: { deleted: number } };
  /** Capability `siteData`: clears the listed kinds for every proxied site (both engines). */
  'siteData.clear': { payload: { kinds: SiteDataKind[] }; result: Empty };
  /** Capability `suggest`: search suggestions fetched through the proxy transport, never via GNOME's server. */
  suggest: { payload: { query: string; provider: SuggestProvider }; result: { items: string[] } };
  /**
   * Capability `vpnVerify`: loads `url` (`/api/vpn/locations` → verify_url) through the current route. The result is
   * the check service's answer as the engine host reports it, never proof that the VPN is active (VpnVerifyResult).
   */
  'vpn.verify': { payload: { url: string }; result: VpnVerifyResult };
  /** Capability `blocker`: what the content blocker compiled, from where, and what it caches (the Extensions page). */
  'blocker.stats': { payload: Empty; result: BlockerStats };
  /**
   * Capability `blocker`: discard every cached engine set and rebuild the current one from the server's lists. Resolves
   * when the build has started (progress in status.blocker); the engines in force stay until the new ones are ready.
   */
  'blocker.reload': { payload: Empty; result: Empty };
}
export type CommandType = keyof CommandMap;
export type CommandPayload<T extends CommandType> = CommandMap[T]['payload'];
export type CommandResult<T extends CommandType> = CommandMap[T]['result'];
export const COMMAND_TYPES: readonly CommandType[] = [
  'init',
  'settings',
  'ticket',
  'status',
  'ping',
  'diagnostics',
  'tab.create',
  'tab.close',
  'tab.activate',
  'tab.navigate',
  'tab.go',
  'tab.reload',
  'tab.stop',
  'tab.state',
  'tab.zoom',
  'tab.find',
  'tab.findClear',
  'tab.action',
  'tab.download',
  'cookies.list',
  'cookies.delete',
  'siteData.clear',
  'suggest',
  'vpn.verify',
  'blocker.stats',
  'blocker.reload',
];

/** Error codes of failed commands. Anything else a peer sends is read as `failed`. */
export type CommandErrorCode =
  | 'unknown_type'
  | 'bad_request'
  | 'bad_state'
  | 'unsupported'
  | 'no_tab'
  | 'tab_exists'
  | 'too_many_tabs'
  | 'no_entry'
  | 'no_document'
  | 'engine_unavailable'
  | 'timeout'
  | 'failed';
export const COMMAND_ERROR_CODES: readonly CommandErrorCode[] = [
  'unknown_type',
  'bad_request',
  'bad_state',
  'unsupported',
  'no_tab',
  'tab_exists',
  'too_many_tabs',
  'no_entry',
  'no_document',
  'engine_unavailable',
  'timeout',
  'failed',
];

// ── Events (engine host → app) ───────────────────────────────────────────────────────────────────────────────────

/**
 * `navigate`: a new document (GNOME-initiated or started in the page). `reload`. `history`: a cross-document
 * traversal (tab.go, or the browser's own Back/Forward moving the frame). `same-document`: pushState, replaceState,
 * fragment navigations and same-document traversals (popstate); `ms` is null.
 */
export type CommitKind = 'navigate' | 'reload' | 'history' | 'same-document';
/**
 * How the commit changed the tab's back/forward list (GNOME's per-tab history, not the frame's own): `push` appends
 * after the current entry and drops the forward entries; `replace` overwrites the current entry; `traverse` moves to
 * another entry. Allowed per kind: navigate → push | replace (a page's `location.replace`); reload → replace;
 * history → traverse; same-document → push (pushState, fragment links) | replace (replaceState) | traverse
 * (popstate). GNOME-initiated loads are `push` (they use `location.replace` on the frame only so that the frame adds
 * no entry to the app tab's joint session history), except the first commit of a restored tab (`tab.create` with
 * `start.kind: 'restore'`), which is `replace` of `entries[index]`.
 */
export type HistoryHandling = 'push' | 'replace' | 'traverse';
export const HISTORY_HANDLING_FOR_KIND: Readonly<Record<CommitKind, readonly HistoryHandling[]>> = {
  navigate: ['push', 'replace'],
  reload: ['replace'],
  history: ['traverse'],
  'same-document': ['push', 'replace', 'traverse'],
};
/**
 * `network`: the destination could not be reached (DNS, connect, TLS and Wisp stream failures look the same to every
 * transport, so v1 has no separate dns/tls kinds; `detail` keeps the transport's words). `timeout`: no document in
 * TIMEOUTS.navigationMs. `engine`: the engine failed (error hook without a network signature, UV error page, frame
 * left the proxy origin, no engine ready). `gateway`: GNOME's gateway (or a custom Wisp server) refused or is down
 * (the transport was offline when the navigation failed). `offline`: the device is offline (navigator.onLine).
 * `blocked`: the content blocker blocked the document (Wave B step 3). The app derives "VPN location down" itself.
 */
export type TabErrorKind = 'network' | 'timeout' | 'engine' | 'gateway' | 'offline' | 'blocked';
export type FailureSignal =
  | 'error-hook'
  | 'timeout'
  | 'uv-error-page'
  | 'frame-left-proxy'
  | 'engine-unavailable'
  | 'fallback-failed'
  | 'blocked';
/** `available`: the other engine is ready and was not tried (also when a non-idempotent navigation was not retried). */
export type FallbackState = 'none' | 'attempted' | 'available';
export type SwitchReason = 'error-hook' | 'timeout' | 'init-failed';
export type OpenDisposition = 'foreground' | 'background' | 'popup';
/** `direct-connection`: a proxied document tried to reach a host directly and GNOME's CSP blocked it. */
export type BlockCategory = 'ads' | 'trackers' | 'annoyances' | 'cookies' | 'urlparams' | 'security' | 'direct-connection';
export const BLOCK_CATEGORIES: readonly BlockCategory[] = [
  'ads',
  'trackers',
  'annoyances',
  'cookies',
  'urlparams',
  'security',
  'direct-connection',
];
export type ContextKind = 'link' | 'image' | 'editable' | 'selection' | 'page';
export interface ContextTarget {
  kind: ContextKind;
  linkUrl: string | null;
  srcUrl: string | null;
  /** The selection, cut to LIMITS.maxSelectionLength. */
  selectionText: string | null;
  /** The selection was longer than the limit: the app offers no Copy item (the page's own copy still works). */
  selectionTruncated: boolean;
  editable: boolean;
}
export type DownloadState = 'completed' | 'failed' | 'cancelled';
export type NeedTicketReason = 'expiring' | 'rejected' | 'missing';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EventMap {
  status: EngineHostStatus;
  needTicket: { reason: NeedTicketReason };
  /**
   * `url`: only with `loading: true`, for a navigation whose destination is known when it starts (GNOME-initiated,
   * Scramjet's request hook, the Navigation API's `navigate` event once it was not cancelled), fitted like
   * tab.committed's (reportUrl; omitted when it does not fit). The app uses it to send that site's content-blocker
   * rules before the page loads and answers every such event with a `settings` snapshot, also when nothing changed
   * (WAVE-B3 D5). The engine host never coalesces an event that carries it and sends at most 2 per tab per second
   * (beyond that, the event goes out without `url`).
   */
  'tab.loading': { tabId: TabId; loading: boolean; url?: string };
  /**
   * `ms` is null for same-document commits. `index`/`length` describe the tab's back/forward list after the commit
   * (canGoBack = index > 0, canGoForward = index < length − 1): the app keeps its copy of the entries for session
   * restore from (historyHandling, index, length, url) and resynchronizes with tab.state when unsure.
   */
  'tab.committed': {
    tabId: TabId;
    navId: NavId | null;
    url: string;
    engine: EngineId;
    kind: CommitKind;
    historyHandling: HistoryHandling;
    index: number;
    length: number;
    canGoBack: boolean;
    canGoForward: boolean;
    ms: number | null;
  };
  /** Never sent for a navigation that turned into a download (that one ends with tab.loading{loading:false}). */
  'tab.loaded': { tabId: TabId; navId: NavId; url: string; engine: EngineId; ms: number };
  'tab.title': { tabId: TabId; title: string };
  'tab.favicon': { tabId: TabId; icon: string | null };
  'tab.error': {
    tabId: TabId;
    navId: NavId | null;
    url: string | null;
    kind: TabErrorKind;
    signal: FailureSignal;
    detail: string;
    engine: EngineId;
    fallback: FallbackState;
    /** False for POST (and other non-GET/HEAD) navigations: they are never retried automatically. */
    idempotent: boolean;
    latencyMs: number;
  };
  'tab.engineSwitched': {
    tabId: TabId;
    navId: NavId;
    from: EngineId;
    to: EngineId;
    reason: SwitchReason;
    latencyMs: number;
  };
  /** The only way a page opens a tab or popup (window.open, target=_blank links and forms). */
  'tab.openRequest': { openerTabId: TabId; url: string; disposition: OpenDisposition; userActivation: boolean };
  /** The page called window.close(). */
  'tab.closeRequest': { tabId: TabId };
  /** Cumulative counts for the tab's current document; coalesced (COALESCE_MS). */
  'tab.blocked': { tabId: TabId; total: number; byCategory: Partial<Record<BlockCategory, number>> };
  /** x/y: engine-host viewport CSS pixels, rounded (fitInt); the app adds the engine iframe's offset. */
  'tab.contextMenu': { tabId: TabId; x: number; y: number; target: ContextTarget };
  /** combo: exactly one of the strings the app sent in EngineSettings.keys.combos. */
  'tab.key': { tabId: TabId; combo: string; repeat: boolean };
  'tab.fullscreen': { tabId: TabId; active: boolean };
  /**
   * A proxied response the browser downloads (proxy-origin.ts downloadDisposition(): an attachment, or a navigation
   * answered with a type browsers do not render; `<a download>` requests). `url` is http(s): downloads of blob:/data:
   * URLs a page builds itself never pass the engines and are not observed (ENGINE-PROTOCOL §6.9).
   */
  'download.started': {
    downloadId: string;
    tabId: TabId;
    url: string;
    filename: string;
    mime: string | null;
    total: number | null;
    engine: EngineId;
  };
  'download.progress': { downloadId: string; received: number; total: number | null };
  'download.done': { downloadId: string; state: DownloadState; received: number; error: string | null };
  /** Diagnostics ring buffer only (may contain URLs: keep it in memory, never persist or include it by default). */
  log: { level: LogLevel; message: string };
}
export type EventType = keyof EventMap;
export const EVENT_TYPES: readonly EventType[] = [
  'status',
  'needTicket',
  'tab.loading',
  'tab.committed',
  'tab.loaded',
  'tab.title',
  'tab.favicon',
  'tab.error',
  'tab.engineSwitched',
  'tab.openRequest',
  'tab.closeRequest',
  'tab.blocked',
  'tab.contextMenu',
  'tab.key',
  'tab.fullscreen',
  'download.started',
  'download.progress',
  'download.done',
  'log',
];

/**
 * App-side token buckets per event type and scope (tab events: per tab; download.progress/done: per download; the
 * rest: per port). The app drops events for unknown tab or download ids before these buckets (forged ids must not
 * use up the budget of real ones), then drops and counts events over the limit. An engine host that coalesces as
 * COALESCE_MS says stays below them on ordinary pages.
 */
export const EVENT_RATE_LIMITS: Readonly<Record<EventType, RateLimit>> = {
  status: { burst: 20, perSecond: 10 },
  needTicket: { burst: 3, perSecond: 0.2 },
  'tab.loading': { burst: 20, perSecond: 10 },
  'tab.committed': { burst: 20, perSecond: 10 },
  'tab.loaded': { burst: 10, perSecond: 5 },
  'tab.title': { burst: 20, perSecond: 10 },
  'tab.favicon': { burst: 5, perSecond: 1 },
  'tab.error': { burst: 5, perSecond: 2 },
  'tab.engineSwitched': { burst: 3, perSecond: 0.5 },
  'tab.openRequest': { burst: 3, perSecond: 0.5 },
  'tab.closeRequest': { burst: 2, perSecond: 0.5 },
  'tab.blocked': { burst: 8, perSecond: 4 },
  'tab.contextMenu': { burst: 4, perSecond: 2 },
  'tab.key': { burst: 30, perSecond: 15 },
  'tab.fullscreen': { burst: 4, perSecond: 2 },
  'download.started': { burst: 5, perSecond: 1 },
  'download.progress': { burst: 10, perSecond: 10 },
  'download.done': { burst: 2, perSecond: 1 },
  log: { burst: 20, perSecond: 5 },
};
/** Across all events of one port, before the per-type buckets. */
export const EVENT_FLOOD_LIMIT: RateLimit = { burst: 800, perSecond: 400 };

/**
 * Engine host: latest-value events are throttled per tab (download.progress: per download) to at most one per
 * interval, at most half the app's bucket rate: the first value of a quiet interval goes out at once, later ones are
 * held and only the newest is sent when the interval ends, so the last value always arrives. For tab.committed only
 * same-document commits with historyHandling `replace` are coalesced (pushes and cross-document commits are entries,
 * never merged). Before any other event of the same tab, its pending coalesced values are sent first, so the order of
 * events per tab is kept.
 */
export const COALESCE_MS = {
  'tab.loading': 200,
  'tab.committed': 200,
  'tab.title': 200,
  'tab.favicon': 2000,
  'tab.blocked': 500,
  'download.progress': 200,
} as const satisfies Partial<Record<EventType, number>>;

/**
 * App: forwarded shortcuts (tab.key) that open or close tabs or GNOME UI (ENGINE-PROTOCOL §6.7) run at most this
 * often, and only while the app document has transient user activation.
 */
export const FORWARDED_PRIVILEGED_LIMIT: RateLimit = { burst: 2, perSecond: 1 };

// ── Envelopes and handshake messages ─────────────────────────────────────────────────────────────────────────────

export interface CommandMessage<T extends CommandType = CommandType> {
  k: 'cmd';
  id: number;
  type: T;
  p: CommandPayload<T>;
}
export type AnyCommandMessage = { [T in CommandType]: CommandMessage<T> }[CommandType];

export interface CommandError {
  code: CommandErrorCode;
  message: string;
}
/** Results are validated per command type with validateCommandResult(); the envelope leaves `p` unknown. */
export type ResultMessage = { k: 'res'; id: number; ok: true; p: unknown } | { k: 'res'; id: number; ok: false; error: CommandError };

export interface EventMessage<T extends EventType = EventType> {
  k: 'evt';
  type: T;
  p: EventMap[T];
}
export type AnyEventMessage = { [T in EventType]: EventMessage<T> }[EventType];

/** Engine host → `window.parent` (to each allowed app origin), every helloIntervalMs until connect. No secrets. */
export interface HelloMessage {
  gnome: 'hello';
  protocol: number;
  build: string;
  /** Random per engine-host document; a reloaded engine host has a new one. */
  instance: string;
}
/** App → the engine iframe (target origin = the proxy origin), with the MessagePort transferred. */
export interface ConnectMessage {
  gnome: 'connect';
  protocol: number;
  /** The instance of the hello being answered: the engine host ignores a connect meant for another instance. */
  instance: string;
}
/** Engine host → app when a connect has another protocol version or no port. */
export interface MismatchMessage {
  gnome: 'mismatch';
  protocol: number;
  instance: string;
}

// ── Validation core ──────────────────────────────────────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path || 'message'}: ${reason}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

/** Result of every validator: the sanitized value, or why it was rejected. */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string; code: 'invalid' | 'unknown_type' };

type Check<T> = (v: unknown, path: string) => T;

function fail(path: string, reason: string): never {
  throw new ValidationError(path, reason);
}

const FORBIDDEN_KEYS: ReadonlySet<string> = /*#__PURE__*/ new Set(['__proto__', 'constructor', 'prototype']);

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own data property (accessors are rejected: structured clone never produces them). */
function dataProperty(obj: Record<string, unknown>, key: string, path: string): unknown {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || !('value' in d)) fail(join(path, key), 'must be a plain data property');
  return d.value;
}

function plainObject(v: unknown, path: string, maxKeys: number): Record<string, unknown> {
  if (!isPlainObject(v)) fail(path, 'expected a plain object');
  const keys = Object.keys(v);
  if (keys.length > maxKeys) fail(path, `more than ${maxKeys} keys`);
  for (const k of keys) if (FORBIDDEN_KEYS.has(k)) fail(join(path, k), 'forbidden key');
  return v;
}

type Shape<T> = { readonly [K in keyof T]-?: Check<T[K]> };

/** Every key of the shape is required; unknown keys are dropped. */
function object<T extends object>(shape: Shape<T>): Check<T> {
  const keys = Object.keys(shape) as Array<keyof T & string>;
  return (v, path) => {
    const obj = plainObject(v, path, LIMITS.maxObjectKeys);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) fail(join(path, k), 'is required');
      out[k] = shape[k](dataProperty(obj, k, path), join(path, k));
    }
    return out as T;
  };
}

/** Every key of the shape is optional (absent stays absent); unknown keys are dropped. */
function partial<T extends object>(shape: Shape<T>): Check<Partial<T>> {
  const keys = Object.keys(shape) as Array<keyof T & string>;
  return (v, path) => {
    const obj = plainObject(v, path, LIMITS.maxObjectKeys);
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = shape[k](dataProperty(obj, k, path), join(path, k));
    }
    return out as Partial<T>;
  };
}

/** Required keys of `shape` plus optional keys of `optional` (absent stays absent); unknown keys are dropped. */
function objectWith<T extends object, O extends object>(shape: Shape<T>, optional: Shape<O>): Check<T & Partial<O>> {
  const required = object<T>(shape);
  const extra = partial<O>(optional);
  return (v, path) => ({ ...extra(v, path), ...required(v, path) });
}

function record<V>(isKey: (k: string) => boolean, value: Check<V>, max: number): Check<Record<string, V>> {
  return (v, path) => {
    const obj = plainObject(v, path, max);
    const out: Record<string, V> = {};
    for (const k of Object.keys(obj)) {
      if (!isKey(k)) fail(join(path, k), 'invalid key');
      out[k] = value(dataProperty(obj, k, path), join(path, k));
    }
    return out;
  };
}

function array<T>(item: Check<T>, max: number, opts: { min?: number; unique?: boolean } = {}): Check<T[]> {
  return (v, path) => {
    if (!Array.isArray(v)) fail(path, 'expected an array');
    const arr: readonly unknown[] = v;
    if (arr.length > max) fail(path, `more than ${max} items`);
    if (arr.length < (opts.min ?? 0)) fail(path, `fewer than ${opts.min ?? 0} items`);
    const out: T[] = [];
    for (let i = 0; i < arr.length; i++) out.push(item(arr[i], `${path}[${i}]`));
    if (opts.unique && new Set(out).size !== out.length) fail(path, 'duplicate items');
    return out;
  };
}

/** Discriminated union on `kind`; every case validates the whole object (including `kind`). */
function variant<T extends { kind: string }>(cases: { readonly [K in T['kind']]: Check<Extract<T, { kind: K }>> }): Check<T> {
  const table = cases as unknown as Readonly<Record<string, Check<T>>>;
  return (v, path) => {
    const obj = plainObject(v, path, LIMITS.maxObjectKeys);
    const kind = dataProperty(obj, 'kind', path);
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(table, kind)) {
      fail(join(path, 'kind'), `expected one of ${Object.keys(table).join(', ')}`);
    }
    return (table[kind] as Check<T>)(obj, path);
  };
}

function refine<T>(check: Check<T>, ok: (v: T) => boolean, reason: string): Check<T> {
  return (v, path) => {
    const out = check(v, path);
    if (!ok(out)) fail(path, reason);
    return out;
  };
}

function nullable<T>(check: Check<T>): Check<T | null> {
  return (v, path) => (v === null ? null : check(v, path));
}

const bool: Check<boolean> = (v, path) => (typeof v === 'boolean' ? v : fail(path, 'expected a boolean'));

function literal<const T extends string | number>(value: T): Check<T> {
  return (v, path) => (v === value ? value : fail(path, `expected ${JSON.stringify(value)}`));
}

function int(min: number, max: number): Check<number> {
  return (v, path) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(path, `expected an integer in ${min}..${max}`);
}

function num(min: number, max: number): Check<number> {
  return (v, path) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(path, `expected a number in ${min}..${max}`);
}

function oneOf<const T extends string>(values: readonly T[]): Check<T> {
  return (v, path) =>
    typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : fail(path, `expected one of ${values.join(', ')}`);
}

// Display text: C0/C1 controls (single line: all of them become spaces; multi-line: kept are \t \n \r, the others
// removed), bidi embedding/override/isolate controls removed (both), lone surrogates replaced with U+FFFD.
const CONTROLS_SINGLE = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROLS_MULTI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Sanitizes display text exactly as the validators do (exported for UI code that shows other untrusted text). */
export function sanitizeText(s: string, multiline = false): string {
  const t = s.replace(LONE_SURROGATES, '�').replace(BIDI_CONTROLS, '');
  return multiline ? t.replace(CONTROLS_MULTI, '') : t.replace(CONTROLS_SINGLE, ' ');
}

/**
 * Engine host, before emitting: `s` cut to at most `max` UTF-16 code units, ending in "…" when cut, never splitting
 * a surrogate pair. (The validators reject text over its limit instead of cutting it.)
 */
export function fitText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${s.slice(0, Math.max(0, end))}…`;
}

/** Engine host, before emitting: a measured number rounded and clamped to an integer range (NaN → min). */
export function fitInt(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(max: number, opts: { min?: number; multiline?: boolean } = {}): Check<string> {
  const min = opts.min ?? 0;
  return (v, path) => {
    if (typeof v !== 'string') fail(path, 'expected a string');
    if (v.length > max) fail(path, `longer than ${max}`);
    const out = sanitizeText(v, opts.multiline);
    if (out.length < min) fail(path, `shorter than ${min}`);
    return out;
  };
}

/** Exact pattern, no sanitization (identifiers, versions, hashes). */
function token(re: RegExp, what: string): Check<string> {
  return (v, path) => (typeof v === 'string' && re.test(v) ? v : fail(path, `expected ${what}`));
}

/**
 * Absolute http(s) URL, re-serialized by the URL parser, credentials removed; null when invalid. Used by both sides
 * (the app before sending, the engine host for what it reports, the validators for what they receive).
 */
export function normalizeHttpUrl(s: string, max: number = LIMITS.maxUrlLength): string | null {
  if (s.length === 0 || s.length > max) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
  u.username = '';
  u.password = '';
  return u.href.length <= max ? u.href : null;
}

const httpUrl: Check<string> = (v, path) => {
  if (typeof v !== 'string') fail(path, 'expected a URL');
  return normalizeHttpUrl(v) ?? fail(path, 'expected an absolute http(s) URL');
};

const wsUrl: Check<string> = (v, path) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > LIMITS.maxWsUrlLength) fail(path, 'expected a ws(s) URL');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return fail(path, 'expected a ws(s) URL');
  }
  if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || !u.hostname || u.username || u.password) {
    fail(path, 'expected a ws(s) URL without credentials');
  }
  return u.href;
};

/** A custom Wisp server: absolute ws:/wss: URL without credentials, or a path on the proxy origin. */
const WISP_PATH_RE = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%-]+\/)*[A-Za-z0-9._~!$&'()*+,;=:@%-]*$/;
const wispServer: Check<string> = (v, path) => {
  if (typeof v === 'string' && v.startsWith('/')) {
    if (v.length <= LIMITS.maxWsUrlLength && WISP_PATH_RE.test(v) && !/(?:^|\/)\.\.?(?:\/|$)/.test(v)) return v;
    return fail(path, 'expected a path on the proxy origin');
  }
  return wsUrl(v, path);
};

/**
 * Whether a `browser.wispServers` entry is one the protocol accepts in `route.custom.servers` (the Settings validator
 * and the snapshot builder use this, so a saved setting can never make `init` fail).
 */
export function isWispServer(s: string): boolean {
  try {
    wispServer(s, '');
    return true;
  } catch {
    return false;
  }
}

const FAVICON_RE = /^data:image\/(?:png|gif|jpeg|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;
const favicon: Check<string> = (v, path) => {
  if (typeof v !== 'string' || v.length > FAVICON_MAX_CHARS) fail(path, 'expected a data:image favicon of at most 64 KiB');
  const m = FAVICON_RE.exec(v);
  const b64 = m?.[1];
  if (!b64 || b64.length % 4 !== 0) fail(path, 'expected a base64 data:image URL (png, gif, jpeg, webp, avif, bmp, ico, svg)');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if ((b64.length / 4) * 3 - pad > LIMITS.faviconMaxBytes) fail(path, 'favicon larger than 64 KiB');
  return v;
};

/**
 * Host keys (`example.com`, `*.example.com`, `example.com:8080`, `[::1]`): the same syntax as the settings
 * (src/settings/validate.ts isHostKey). src/shared/site-rules.ts says how a URL finds its rule.
 */
export const HOST_KEY_RE =
  /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i;
export function isHostKey(k: string): boolean {
  return k.length > 0 && k.length <= LIMITS.maxHostKeyLength && HOST_KEY_RE.test(k);
}
const hostKey: Check<string> = (v, path) => (typeof v === 'string' && isHostKey(v) ? v : fail(path, 'expected a host key'));
/** A site for cookie filters: lower-case host name or IP literal, no wildcard, no port. */
const SITE_RE =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$|^\[[0-9a-f:.]+\]$/;
const site: Check<string> = (v, path) =>
  typeof v === 'string' && v.length <= 253 && SITE_RE.test(v) ? v : fail(path, 'expected a lower-case host name');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const BUILD_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const INSTANCE_RE = /^[a-z0-9]{8,32}$/;
const TICKET_RE = /^[A-Za-z0-9._~-]{8,512}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMBO_RE = /^[\x21-\x7e]{1,48}$/;
/**
 * Whether a combo may travel in `keys.combos` / `tab.key` (visible ASCII, ≤ LIMITS.maxComboLength). The snapshot
 * builder sends the canonical form (src/lib/keys.ts normalizeCombo), each combo once.
 */
export function isCombo(s: string): boolean {
  return COMBO_RE.test(s);
}
const DOWNLOAD_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIME_RE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/;
const IP_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const DIRECTIVE_RE = /^[a-z-]{1,32}$/;
const COOKIE_DOMAIN_RE = /^\.?[A-Za-z0-9.:[\]_-]{1,253}$/;

// ── Shared checks ────────────────────────────────────────────────────────────────────────────────────────────────

const tabId = /*#__PURE__*/ int(1, LIMITS.maxTabId);
const navId = /*#__PURE__*/ int(1, Number.MAX_SAFE_INTEGER);
const engineId = /*#__PURE__*/ oneOf(ENGINE_IDS);
const transportKind = /*#__PURE__*/ oneOf(TRANSPORT_KINDS);
const duration = /*#__PURE__*/ int(0, LIMITS.maxDurationMs);
const timestamp = /*#__PURE__*/ int(0, Number.MAX_SAFE_INTEGER);
const count = /*#__PURE__*/ int(0, Number.MAX_SAFE_INTEGER);
const bytes = /*#__PURE__*/ int(0, Number.MAX_SAFE_INTEGER);
const detail = /*#__PURE__*/ text(LIMITS.maxDetailLength);
const versionString = /*#__PURE__*/ token(VERSION_RE, 'a version string');
const buildId = /*#__PURE__*/ token(BUILD_RE, 'a build id');
const instanceId = /*#__PURE__*/ token(INSTANCE_RE, 'an instance id');
const empty: Check<Empty> = (v, path) => {
  plainObject(v, path, LIMITS.maxObjectKeys);
  return {};
};
const tabRef = /*#__PURE__*/ object<TabRef>({ tabId });
const permissionDecision = /*#__PURE__*/ oneOf<PermissionDecision>(['allow', 'block']);
const capabilities = /*#__PURE__*/ array(oneOf(CAPABILITIES), CAPABILITIES.length, { unique: true });

const engineStatus = /*#__PURE__*/ object<EngineStatus>({
  state: oneOf<EngineState>(['initializing', 'ready', 'failed', 'disabled']),
  version: versionString,
  detail: nullable(detail),
});
const transportStatus = /*#__PURE__*/ object<TransportStatus>({
  state: oneOf<TransportState>(['connecting', 'ready', 'degraded', 'offline']),
  transport: transportKind,
  endpoint: oneOf<EndpointKind>(['default', 'profile', 'custom']),
  detail: nullable(oneOf(TRANSPORT_DETAILS)),
  since: timestamp,
  retryInMs: nullable(duration),
});
const perEngine = <T>(c: Check<T>): Check<Record<EngineId, T>> => object<Record<EngineId, T>>({ scramjet: c, ultraviolet: c });
const engineHostStatus = /*#__PURE__*/ object<EngineHostStatus>({
  engines: perEngine(engineStatus),
  transport: perEngine(transportStatus),
  sw: object<SwStatus>({ controlled: bool, build: nullable(buildId), current: bool, updateWaiting: bool }),
  blocker: object<BlockerStatus>({
    state: oneOf<BlockerState>(['off', 'building', 'ready', 'failed']),
    lists: int(0, LIMITS.maxFilterLists),
    detail: nullable(detail),
  }),
});
const engineVersions = /*#__PURE__*/ object<EngineVersions>({
  build: buildId,
  scramjet: versionString,
  scramjetController: versionString,
  ultraviolet: versionString,
  bareMux: versionString,
  transports: perEngine(object<Record<TransportKind, string>>({ libcurl: versionString, epoxy: versionString })),
});

const wispRoute = /*#__PURE__*/ variant<WispRoute>({
  default: object<{ kind: 'default' }>({ kind: literal('default') }),
  profile: object<{ kind: 'profile'; id: string }>({ kind: literal('profile'), id: token(ID_RE, 'a profile id') }),
  custom: object<{ kind: 'custom'; servers: string[] }>({
    kind: literal('custom'),
    servers: array(wispServer, LIMITS.maxWispServers, { min: 1, unique: true }),
  }),
});

const enginePermissions = /*#__PURE__*/ object<EnginePermissionSet>({
  autoplay: permissionDecision,
  fullscreen: permissionDecision,
  clipboard: permissionDecision,
});
const enforcedPermissions = /*#__PURE__*/ array(oneOf(ENGINE_PERMISSIONS), ENGINE_PERMISSIONS.length, { unique: true });

const engineSettings = /*#__PURE__*/ object<EngineSettings>({
  engines: perEngine(bool),
  engine: oneOf<'auto' | EngineId>(['auto', 'scramjet', 'ultraviolet']),
  autoFallback: bool,
  transport: transportKind,
  route: wispRoute,
  privacy: object<EngineSettings['privacy']>({
    webrtc: oneOf<'block' | 'allow'>(['block', 'allow']),
    sendGpc: bool,
    doNotTrack: bool,
    referrer: oneOf<EngineSettings['privacy']['referrer']>(['default', 'origin-cross-site', 'none']),
    stripTrackingParams: bool,
    cookies: oneOf<EngineSettings['privacy']['cookies']>(['all', 'block-third-party', 'block-all']),
  }),
  extensions: objectWith<Omit<EngineSettings['extensions'], 'cacheLimitMB'>, { cacheLimitMB: number }>({
    enabled: object<EngineSettings['extensions']['enabled']>({
      adblock: bool,
      trackers: bool,
      privacy: bool,
      cookies: bool,
      cosmetic: bool,
    }),
    lists: array(
      object<FilterListRef>({
        id: token(ID_RE, 'a filter list id'),
        sha256: token(SHA256_RE, 'a lower-case hex SHA-256'),
        category: oneOf<FilterCategory>(['ads', 'privacy', 'annoyances', 'cookies', 'urlparams', 'security', 'resources']),
        format: oneOf<'abp' | 'resources'>(['abp', 'resources']),
        trusted: bool,
      }),
      LIMITS.maxFilterLists,
    ),
    allowlist: array(hostKey, LIMITS.maxSiteRules, { unique: true }),
    perSite: record(
      isHostKey,
      partial<{ adblock: boolean; trackers: boolean; cosmetic: boolean }>({ adblock: bool, trackers: bool, cosmetic: bool }),
      LIMITS.maxSiteRules,
    ),
    cosmeticAggressive: bool,
    cookieRules: record(isHostKey, oneOf<'allow' | 'session' | 'block'>(['allow', 'session', 'block']), LIMITS.maxSiteRules),
  }, { cacheLimitMB: int(16, 8192) }),
  keys: object<EngineSettings['keys']>({
    combos: array(token(COMBO_RE, 'a key combo'), LIMITS.maxCombos, { unique: true }),
    apple: bool,
  }),
});

const ticket = /*#__PURE__*/ object<Ticket>({
  value: token(TICKET_RE, 'a ticket (URL-safe characters only)'),
  expiresAt: timestamp,
  wispUrl: wsUrl,
});

const zoomFactor = /*#__PURE__*/ num(LIMITS.zoomMin, LIMITS.zoomMax);

const urlStartBase = /*#__PURE__*/ object<{ kind: 'url'; url: string }>({ kind: literal('url'), url: httpUrl });
const urlStartOpener = /*#__PURE__*/ partial<{ opener: string }>({ opener: httpUrl });
/** `{kind: 'url', url}` and, only when present, `opener` (absent stays absent). */
const urlStart: Check<Extract<TabStart, { kind: 'url' }>> = (v, path) => {
  const base = urlStartBase(v, path);
  const { opener } = urlStartOpener(v, path);
  return opener === undefined ? base : { ...base, opener };
};

const tabStart = /*#__PURE__*/ variant<TabStart>({
  blank: object<{ kind: 'blank' }>({ kind: literal('blank') }),
  url: urlStart,
  restore: refine(
    object<{ kind: 'restore'; entries: string[]; index: number }>({
      kind: literal('restore'),
      entries: array(httpUrl, LIMITS.maxTabHistory, { min: 1 }),
      index: int(0, LIMITS.maxTabHistory - 1),
    }),
    (s) => s.index < s.entries.length,
    'index outside entries',
  ),
});

const navStart = /*#__PURE__*/ object<NavStart>({ navId, engine: engineId });

const tabError = /*#__PURE__*/ object<EventMap['tab.error']>({
  tabId,
  navId: nullable(navId),
  url: nullable(httpUrl),
  kind: oneOf<TabErrorKind>(['network', 'timeout', 'engine', 'gateway', 'offline', 'blocked']),
  signal: oneOf<FailureSignal>([
    'error-hook',
    'timeout',
    'uv-error-page',
    'frame-left-proxy',
    'engine-unavailable',
    'fallback-failed',
    'blocked',
  ]),
  detail,
  engine: engineId,
  fallback: oneOf<FallbackState>(['none', 'attempted', 'available']),
  idempotent: bool,
  latencyMs: duration,
});

const tabState = /*#__PURE__*/ refine(
  object<TabState>({
    entries: array(httpUrl, LIMITS.maxTabHistory),
    index: int(0, LIMITS.maxTabHistory - 1),
    title: nullable(text(LIMITS.maxTitleLength)),
    loading: bool,
    navId: nullable(navId),
    engine: nullable(engineId),
    error: nullable(tabError),
  }),
  (s) => (s.entries.length === 0 ? s.index === 0 : s.index < s.entries.length),
  'index must point into entries (0 while there are none)',
);

const cookieInfo = /*#__PURE__*/ object<CookieInfo>({
  engine: engineId,
  domain: token(COOKIE_DOMAIN_RE, 'a cookie domain'),
  path: refine(text(LIMITS.maxCookiePathLength, { min: 1 }), (p) => p.startsWith('/'), 'cookie paths start with /'),
  name: text(LIMITS.maxCookieNameLength),
  size: int(0, 1_048_576),
  expires: nullable(timestamp),
  secure: bool,
  httpOnly: bool,
  sameSite: nullable(oneOf<'strict' | 'lax' | 'none'>(['strict', 'lax', 'none'])),
});

const diagnosticsResult = /*#__PURE__*/ objectWith<Omit<EngineDiagnostics, 'blocker'>, { blocker: NonNullable<EngineDiagnostics['blocker']> }>({
  instance: instanceId,
  uptimeMs: timestamp,
  status: engineHostStatus,
  versions: engineVersions,
  capabilities,
  enforcedPermissions,
  tabs: object<EngineDiagnostics['tabs']>({ live: count, scramjet: count, ultraviolet: count }),
  sw: object<EngineDiagnostics['sw']>({ starts: count, held: count, unavailable: count }),
  csp: object<EngineDiagnostics['csp']>({
    violations: count,
    byDirective: record((k) => DIRECTIVE_RE.test(k), count, LIMITS.maxDiagnosticsDirectives),
  }),
  webrtc: object<EngineDiagnostics['webrtc']>({ policy: oneOf<'block' | 'allow'>(['block', 'allow']), blocked: count }),
  transport: object<EngineDiagnostics['transport']>({
    probes: object<EngineDiagnostics['transport']['probes']>({
      valid: count,
      rejected: count,
      unreachable: count,
      rateLimited: count,
      upstreamDown: count,
      unknownProfile: count,
    }),
    rebuilds: perEngine(count),
    drops: perEngine(count),
  }),
  fallback: object<EngineDiagnostics['fallback']>({ switched: count, notRetried: count }),
  protocol: object<EngineDiagnostics['protocol']>({ rejectedCommands: count }),
  memory: nullable(object<{ usedJSHeapSize: number; totalJSHeapSize: number }>({ usedJSHeapSize: bytes, totalJSHeapSize: bytes })),
  mainThread: object<EngineDiagnostics['mainThread']>({ maxLagMs: duration, longTasks: count, longTaskMs: count }),
}, {
  blocker: object<NonNullable<EngineDiagnostics['blocker']>>({
    hookErrors: count,
    wsBackstopBlocked: count,
    wsBackstopSkipped: count,
    announceWaits: count,
    announceTimeouts: count,
  }),
});

const blockerGroup = /*#__PURE__*/ oneOf(BLOCKER_GROUPS);
const blockerStats = /*#__PURE__*/ object<BlockerStats>({
  engineVersion: int(0, 65_535),
  builtAt: nullable(timestamp),
  buildMs: nullable(duration),
  source: nullable(oneOf<'cache' | 'build'>(['cache', 'build'])),
  engines: array(
    object<BlockerStats['engines'][number]>({ group: blockerGroup, bytes, network: count, cosmetic: count, scriptlets: count }),
    BLOCKER_GROUPS.length,
  ),
  lists: array(
    object<BlockerListStats>({
      id: token(ID_RE, 'a filter list id'),
      sha256: token(SHA256_RE, 'a lower-case hex SHA-256'),
      state: oneOf<BlockerListStats['state']>(['compiled', 'failed']),
      error: nullable(oneOf<BlockerListError>(BLOCKER_LIST_ERRORS)),
      rules: count,
      dropped: count,
    }),
    LIMITS.maxFilterLists,
  ),
  cache: object<BlockerStats['cache']>({ bytes, entries: count, limitBytes: bytes }),
  resources: nullable(object<NonNullable<BlockerStats['resources']>>({ redirects: count, scriptlets: count })),
});

// ── Per-type validators ──────────────────────────────────────────────────────────────────────────────────────────

type PayloadChecks = { readonly [T in CommandType]: Check<CommandPayload<T>> };
type ResultChecks = { readonly [T in CommandType]: Check<CommandResult<T>> };

/** Command payloads (the engine host's half). */
const COMMAND_PAYLOADS: PayloadChecks = /*#__PURE__*/ (() => ({
  init: objectWith<Omit<InitPayload, 'blockerKey'>, { blockerKey: string }>(
    {
      settings: engineSettings,
      ticket: nullable(ticket),
      clearOnStart: object<InitPayload['clearOnStart']>({ cookies: bool, siteData: bool }),
    },
    { blockerKey: token(SHA256_RE, 'a 64-digit lower-case hex key') },
  ),
  settings: object<{ settings: EngineSettings }>({ settings: engineSettings }),
  ticket,
  status: empty,
  ping: empty,
  diagnostics: empty,
  'tab.create': object<CommandPayload<'tab.create'>>({
    tabId,
    active: bool,
    engine: nullable(engineId),
    zoom: zoomFactor,
    start: tabStart,
    permissions: enginePermissions,
  }),
  'tab.close': tabRef,
  'tab.activate': object<{ tabId: TabId | null }>({ tabId: nullable(tabId) }),
  'tab.navigate': object<CommandPayload<'tab.navigate'>>({ tabId, url: httpUrl, engine: nullable(engineId), permissions: enginePermissions }),
  'tab.go': object<CommandPayload<'tab.go'>>({
    tabId,
    delta: refine(int(-LIMITS.maxGoDelta, LIMITS.maxGoDelta), (d) => d !== 0, 'delta must not be 0'),
    permissions: enginePermissions,
  }),
  'tab.reload': object<CommandPayload<'tab.reload'>>({ tabId, permissions: enginePermissions }),
  'tab.stop': tabRef,
  'tab.state': tabRef,
  'tab.zoom': object<CommandPayload<'tab.zoom'>>({ tabId, factor: zoomFactor }),
  'tab.find': object<CommandPayload<'tab.find'>>({
    tabId,
    query: text(LIMITS.maxFindQuery, { multiline: true }),
    backwards: bool,
    caseSensitive: bool,
  }),
  'tab.findClear': tabRef,
  'tab.action': object<CommandPayload<'tab.action'>>({ tabId, action: oneOf<'selectAll' | 'print'>(['selectAll', 'print']) }),
  'tab.download': object<CommandPayload<'tab.download'>>({ tabId, url: httpUrl, kind: oneOf<'link' | 'image'>(['link', 'image']) }),
  'cookies.list': object<CommandPayload<'cookies.list'>>({ site: nullable(site) }),
  'cookies.delete': refine(
    object<CommandPayload<'cookies.delete'>>({
      all: bool,
      site: nullable(site),
      name: nullable(text(LIMITS.maxCookieNameLength, { min: 1 })),
    }),
    (p) => (p.all ? p.site === null && p.name === null : p.site !== null),
    'all: true takes no site or name; otherwise site is required',
  ),
  'siteData.clear': object<CommandPayload<'siteData.clear'>>({
    kinds: array(oneOf<SiteDataKind>(['cookies', 'storage', 'cache']), 3, { min: 1, unique: true }),
  }),
  suggest: object<CommandPayload<'suggest'>>({
    query: text(LIMITS.maxSuggestQuery, { min: 1 }),
    provider: oneOf(SUGGEST_PROVIDERS),
  }),
  'vpn.verify': object<CommandPayload<'vpn.verify'>>({ url: httpUrl }),
  'blocker.stats': empty,
  'blocker.reload': empty,
}))();

/** Command results (the app's half). */
const COMMAND_RESULTS: ResultChecks = /*#__PURE__*/ (() => ({
  init: object<InitResult>({
    instance: instanceId,
    status: engineHostStatus,
    versions: engineVersions,
    capabilities,
    enforcedPermissions,
    timings: object<InitResult['timings']>({
      swReadyMs: duration,
      scramjetMs: nullable(duration),
      ultravioletMs: nullable(duration),
      totalMs: duration,
    }),
  }),
  settings: empty,
  ticket: empty,
  status: engineHostStatus,
  ping: object<{ instance: string; uptimeMs: number }>({ instance: instanceId, uptimeMs: timestamp }),
  diagnostics: diagnosticsResult,
  'tab.create': refine(
    object<CommandResult<'tab.create'>>({ navId: nullable(navId), engine: nullable(engineId) }),
    (r) => (r.navId === null) === (r.engine === null),
    'navId and engine are both set or both null',
  ),
  'tab.close': empty,
  'tab.activate': empty,
  'tab.navigate': navStart,
  'tab.go': navStart,
  'tab.reload': navStart,
  'tab.stop': empty,
  'tab.state': tabState,
  'tab.zoom': object<{ factor: number }>({ factor: zoomFactor }),
  'tab.find': refine(
    object<FindResult>({
      matches: int(0, LIMITS.findMaxMatches),
      active: int(0, LIMITS.findMaxMatches),
      highlights: bool,
      capped: bool,
    }),
    (r) => r.active <= r.matches && (r.matches === 0) === (r.active === 0),
    'active must be 1..matches (0 without matches)',
  ),
  'tab.findClear': empty,
  'tab.action': empty,
  'tab.download': empty,
  'cookies.list': object<CommandResult<'cookies.list'>>({ cookies: array(cookieInfo, LIMITS.maxCookies), truncated: bool }),
  'cookies.delete': object<{ deleted: number }>({ deleted: count }),
  'siteData.clear': empty,
  suggest: object<{ items: string[] }>({
    items: array(text(LIMITS.maxSuggestionLength, { min: 1 }), LIMITS.maxSuggestions),
  }),
  'vpn.verify': object<VpnVerifyResult>({
    ip: token(IP_RE, 'an IP address'),
    country: nullable(text(64)),
    city: nullable(text(128)),
    vpnExit: nullable(bool),
    checkedAt: timestamp,
  }),
  'blocker.stats': blockerStats,
  'blocker.reload': empty,
}))();

type EventChecks = { readonly [T in EventType]: Check<EventMap[T]> };

const EVENTS: EventChecks = /*#__PURE__*/ (() => ({
  status: engineHostStatus,
  needTicket: object<EventMap['needTicket']>({ reason: oneOf<NeedTicketReason>(['expiring', 'rejected', 'missing']) }),
  'tab.loading': refine(
    objectWith<{ tabId: TabId; loading: boolean }, { url: string }>({ tabId, loading: bool }, { url: httpUrl }),
    (e) => e.url === undefined || e.loading,
    'url only with loading: true',
  ),
  'tab.committed': refine(
    refine(
      object<EventMap['tab.committed']>({
        tabId,
        navId: nullable(navId),
        url: httpUrl,
        engine: engineId,
        kind: oneOf<CommitKind>(['navigate', 'reload', 'history', 'same-document']),
        historyHandling: oneOf<HistoryHandling>(['push', 'replace', 'traverse']),
        index: int(0, LIMITS.maxTabHistory - 1),
        length: int(1, LIMITS.maxTabHistory),
        canGoBack: bool,
        canGoForward: bool,
        ms: nullable(duration),
      }),
      (e) => (e.kind === 'same-document') === (e.ms === null) && HISTORY_HANDLING_FOR_KIND[e.kind].includes(e.historyHandling),
      'ms is null exactly for same-document commits, and historyHandling must fit the kind',
    ),
    (e) => e.index < e.length && e.canGoBack === e.index > 0 && e.canGoForward === e.index < e.length - 1,
    'index, length, canGoBack and canGoForward disagree',
  ),
  'tab.loaded': object<EventMap['tab.loaded']>({ tabId, navId, url: httpUrl, engine: engineId, ms: duration }),
  'tab.title': object<EventMap['tab.title']>({ tabId, title: text(LIMITS.maxTitleLength) }),
  'tab.favicon': object<EventMap['tab.favicon']>({ tabId, icon: nullable(favicon) }),
  'tab.error': tabError,
  'tab.engineSwitched': refine(
    object<EventMap['tab.engineSwitched']>({
      tabId,
      navId,
      from: engineId,
      to: engineId,
      reason: oneOf<SwitchReason>(['error-hook', 'timeout', 'init-failed']),
      latencyMs: duration,
    }),
    (e) => e.from !== e.to,
    'from and to must differ',
  ),
  'tab.openRequest': object<EventMap['tab.openRequest']>({
    openerTabId: tabId,
    url: httpUrl,
    disposition: oneOf<OpenDisposition>(['foreground', 'background', 'popup']),
    userActivation: bool,
  }),
  'tab.closeRequest': object<EventMap['tab.closeRequest']>({ tabId }),
  'tab.blocked': object<EventMap['tab.blocked']>({
    tabId,
    total: count,
    byCategory: partial<Record<BlockCategory, number>>({
      ads: count,
      trackers: count,
      annoyances: count,
      cookies: count,
      urlparams: count,
      security: count,
      'direct-connection': count,
    }),
  }),
  'tab.contextMenu': object<EventMap['tab.contextMenu']>({
    tabId,
    x: int(-32_768, 32_767),
    y: int(-32_768, 32_767),
    target: refine(
      object<ContextTarget>({
        kind: oneOf<ContextKind>(['link', 'image', 'editable', 'selection', 'page']),
        linkUrl: nullable(httpUrl),
        srcUrl: nullable(httpUrl),
        selectionText: nullable(text(LIMITS.maxSelectionLength, { multiline: true })),
        selectionTruncated: bool,
        editable: bool,
      }),
      (t) => t.selectionText !== null || !t.selectionTruncated,
      'selectionTruncated needs a selectionText',
    ),
  }),
  'tab.key': object<EventMap['tab.key']>({ tabId, combo: token(COMBO_RE, 'a key combo'), repeat: bool }),
  'tab.fullscreen': object<EventMap['tab.fullscreen']>({ tabId, active: bool }),
  'download.started': object<EventMap['download.started']>({
    downloadId: token(DOWNLOAD_ID_RE, 'a download id'),
    tabId,
    url: httpUrl,
    filename: refine(
      text(LIMITS.maxFilenameLength, { min: 1 }),
      (f) => f.trim() !== '' && !/[/\\]/.test(f) && f !== '.' && f !== '..',
      'file names are not blank and have no path separators',
    ),
    mime: nullable(token(MIME_RE, 'a bare lower-case MIME type')),
    total: nullable(bytes),
    engine: engineId,
  }),
  'download.progress': object<EventMap['download.progress']>({
    downloadId: token(DOWNLOAD_ID_RE, 'a download id'),
    received: bytes,
    total: nullable(bytes),
  }),
  'download.done': object<EventMap['download.done']>({
    downloadId: token(DOWNLOAD_ID_RE, 'a download id'),
    state: oneOf<DownloadState>(['completed', 'failed', 'cancelled']),
    received: bytes,
    error: nullable(detail),
  }),
  log: object<EventMap['log']>({
    level: oneOf<LogLevel>(['debug', 'info', 'warn', 'error']),
    message: text(LIMITS.maxMessageLength, { multiline: true }),
  }),
}))();

// ── Public validators ────────────────────────────────────────────────────────────────────────────────────────────

function run<T>(check: Check<T>, v: unknown, path = ''): Validated<T> {
  try {
    return { ok: true, value: check(v, path) };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message, code: 'invalid' };
    // A RangeError from a pathological input (e.g. a regular expression on a huge string) is a rejection too.
    return { ok: false, error: `message: ${err instanceof Error ? err.name : 'unexpected input'}`, code: 'invalid' };
  }
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** App → engine host: the payload of one command type (the engine host runs this before any handler). */
export function validateCommandPayload<T extends CommandType>(type: T, p: unknown): Validated<CommandPayload<T>> {
  if (!hasOwn(COMMAND_PAYLOADS, type)) return { ok: false, error: `unknown command ${String(type).slice(0, 40)}`, code: 'unknown_type' };
  return run(COMMAND_PAYLOADS[type] as Check<CommandPayload<T>>, p, 'p');
}

/** Engine host → app: the result of one command (the app runs this before resolving the command's promise). */
export function validateCommandResult<T extends CommandType>(type: T, p: unknown): Validated<CommandResult<T>> {
  if (!hasOwn(COMMAND_RESULTS, type)) return { ok: false, error: `unknown command ${String(type).slice(0, 40)}`, code: 'unknown_type' };
  return run(COMMAND_RESULTS[type] as Check<CommandResult<T>>, p, 'p');
}

/** Engine host → app: the payload of one event type. */
export function validateEventPayload<T extends EventType>(type: T, p: unknown): Validated<EventMap[T]> {
  if (!hasOwn(EVENTS, type)) return { ok: false, error: `unknown event ${String(type).slice(0, 40)}`, code: 'unknown_type' };
  return run(EVENTS[type] as Check<EventMap[T]>, p, 'p');
}

const commandId = /*#__PURE__*/ int(1, Number.MAX_SAFE_INTEGER);

/**
 * Engine host: a whole command message from the port. On failure `id` is set when the message had a valid id: answer
 * `{k: 'res', id, ok: false, error: {code: code === 'unknown_type' ? 'unknown_type' : 'bad_request', message}}`.
 */
export function validateCommandMessage(data: unknown): Validated<AnyCommandMessage> & { id?: number } {
  return envelope(data, 'cmd', (type, p) => validateCommandPayload(type as CommandType, p), (type) => (COMMAND_TYPES as readonly string[]).includes(type));
}

/** App: a whole event message from the port. Unknown types are ignored (newer engine host), not counted as hostile. */
export function validateEventMessage(data: unknown): Validated<AnyEventMessage> {
  return envelope(data, 'evt', (type, p) => validateEventPayload(type as EventType, p), (type) => (EVENT_TYPES as readonly string[]).includes(type));
}

function envelope<M>(
  data: unknown,
  k: 'cmd' | 'evt',
  payload: (type: string, p: unknown) => Validated<unknown>,
  known: (type: string) => boolean,
): Validated<M> & { id?: number } {
  // A command's id is read first, so the engine host can answer even an unknown or invalid command.
  let id: number | undefined;
  const failed = (error: string, code: 'invalid' | 'unknown_type'): Validated<M> & { id?: number } =>
    id === undefined ? { ok: false, error, code } : { ok: false, error, code, id };
  try {
    const obj = plainObject(data, '', 8);
    if (dataProperty(obj, 'k', '') !== k) fail('k', `expected "${k}"`);
    if (k === 'cmd') id = commandId(dataProperty(obj, 'id', ''), 'id');
    const type = dataProperty(obj, 'type', '');
    if (typeof type !== 'string' || type.length > 40) fail('type', 'expected a message type');
    if (!known(type)) return failed(`unknown ${k === 'cmd' ? 'command' : 'event'} ${type}`, 'unknown_type');
    if (!hasOwn(obj, 'p')) fail('p', 'is required');
    const p = payload(type, dataProperty(obj, 'p', ''));
    if (!p.ok) return failed(p.error, p.code);
    return { ok: true, value: (k === 'cmd' ? { k, id, type, p: p.value } : { k, type, p: p.value }) as M };
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'invalid message', 'invalid');
  }
}

const commandError = /*#__PURE__*/ object<CommandError>({
  code: (v, path) => {
    if (typeof v !== 'string' || v.length > 40) fail(path, 'expected an error code');
    return (COMMAND_ERROR_CODES as readonly string[]).includes(v) ? (v as CommandErrorCode) : 'failed';
  },
  message: text(LIMITS.maxMessageLength),
});

/** App: the envelope of a command result; validate `p` with validateCommandResult(type of the pending command). */
export function validateResultMessage(data: unknown): Validated<ResultMessage> {
  return run<ResultMessage>((v, path) => {
    const obj = plainObject(v, path, 8);
    if (dataProperty(obj, 'k', path) !== 'res') fail('k', 'expected "res"');
    const id = commandId(dataProperty(obj, 'id', path), 'id');
    const ok = bool(dataProperty(obj, 'ok', path), 'ok');
    if (ok) {
      if (!hasOwn(obj, 'p')) fail('p', 'is required');
      return { k: 'res', id, ok: true, p: dataProperty(obj, 'p', path) };
    }
    if (!hasOwn(obj, 'error')) fail('error', 'is required');
    return { k: 'res', id, ok: false, error: commandError(dataProperty(obj, 'error', path), 'error') };
  }, data);
}

const protocolNumber = /*#__PURE__*/ int(1, 1000);

export function validateHello(data: unknown): Validated<HelloMessage> {
  return run(
    object<HelloMessage>({ gnome: literal('hello'), protocol: protocolNumber, build: buildId, instance: instanceId }),
    data,
  );
}

export function validateConnect(data: unknown): Validated<ConnectMessage> {
  return run(object<ConnectMessage>({ gnome: literal('connect'), protocol: protocolNumber, instance: instanceId }), data);
}

export function validateMismatch(data: unknown): Validated<MismatchMessage> {
  return run(object<MismatchMessage>({ gnome: literal('mismatch'), protocol: protocolNumber, instance: instanceId }), data);
}

/** For tests and debug builds of the engine host: check settings the app is about to send. */
export function validateEngineSettings(data: unknown): Validated<EngineSettings> {
  return run(engineSettings, data);
}

// ── Handshake decisions (the hardened rules of docs/ENGINE-PROTOCOL.md §2, as pure functions) ────────────────────

export interface HelloContext {
  /** The engine iframe's contentWindow. */
  expectedSource: unknown;
  /** `/api/config` → proxy.origin. */
  proxyOrigin: string;
  /**
   * True only between the app creating (or replacing) the engine iframe and accepting one hello (§2.2, §2.3). The
   * hello timeout (TIMEOUTS.helloWaitMs) does not end it: the app shows "did not start", and a late first hello from
   * that same iframe still connects (a slow start recovers; a hello forged into a never-connected engine host could
   * arrive inside the window just as well, so a late one is no compromise signal). Only an accepted hello (connect or
   * mismatch) or replacing the iframe ends it.
   */
  expecting: boolean;
  /** Instance of the engine host the app is connected to (null before the first connect). */
  connectedInstance: string | null;
}

export type HelloDecision =
  | { action: 'connect'; hello: HelloMessage }
  | { action: 'mismatch'; hello: HelloMessage }
  /** A valid hello from the engine iframe the app did not ask for: ignore it and count it as a compromise signal. */
  | { action: 'unexpected'; hello: HelloMessage }
  | { action: 'ignore'; reason: 'source' | 'origin' | 'invalid' | 'duplicate' };

/** App side: what to do with a window `message` event that may be a hello. */
export function decideHello(ev: { source: unknown; origin: string; data: unknown }, ctx: HelloContext): HelloDecision {
  if (ev.source !== ctx.expectedSource || ev.source === null || ev.source === undefined) return { action: 'ignore', reason: 'source' };
  if (ev.origin !== ctx.proxyOrigin) return { action: 'ignore', reason: 'origin' };
  const hello = validateHello(ev.data);
  if (!hello.ok) return { action: 'ignore', reason: 'invalid' };
  // The engine host repeats hello until connect arrives: copies from the connected instance are harmless.
  if (hello.value.instance === ctx.connectedInstance) return { action: 'ignore', reason: 'duplicate' };
  if (!ctx.expecting) return { action: 'unexpected', hello: hello.value };
  if (hello.value.protocol !== PROTOCOL_VERSION) return { action: 'mismatch', hello: hello.value };
  return { action: 'connect', hello: hello.value };
}

export interface ConnectContext {
  /** window.parent */
  parent: unknown;
  /** The app origins templated into the engine-host document (the same list as its frame-ancestors). */
  appOrigins: readonly string[];
  /** This engine-host document's instance id. */
  instance: string;
  /** A port was already accepted: one port per engine-host load. */
  connected: boolean;
}

export type ConnectDecision =
  | { action: 'accept' }
  /** Reply `{gnome: 'mismatch', protocol: PROTOCOL_VERSION, instance}` to event.origin. */
  | { action: 'mismatch' }
  | { action: 'ignore'; reason: 'source' | 'origin' | 'invalid' | 'instance' | 'connected' };

/** Engine-host side: what to do with a window `message` event that may be a connect. */
export function decideConnect(ev: { source: unknown; origin: string; data: unknown; ports: readonly unknown[] }, ctx: ConnectContext): ConnectDecision {
  if (ev.source !== ctx.parent || ev.source === null || ev.source === undefined) return { action: 'ignore', reason: 'source' };
  if (!ctx.appOrigins.includes(ev.origin)) return { action: 'ignore', reason: 'origin' };
  if (ctx.connected) return { action: 'ignore', reason: 'connected' };
  const raw = ev.data;
  // A connect with another protocol version must still get a mismatch answer, so check the version first.
  if (isPlainObject(raw) && raw.gnome === 'connect' && typeof raw.protocol === 'number' && raw.protocol !== PROTOCOL_VERSION) {
    return { action: 'mismatch' };
  }
  const connect = validateConnect(raw);
  if (!connect.ok) return { action: 'ignore', reason: 'invalid' };
  if (connect.value.instance !== ctx.instance) return { action: 'ignore', reason: 'instance' };
  if (ev.ports.length !== 1) return { action: 'mismatch' };
  return { action: 'accept' };
}

// ── Runtime helpers ──────────────────────────────────────────────────────────────────────────────────────────────

/** App-side timeout of a command (navigation commands resolve when the navigation has started). */
export function commandTimeoutMs(type: CommandType): number {
  switch (type) {
    case 'init':
      return TIMEOUTS.initMs;
    case 'ticket':
      return TIMEOUTS.ticketMs;
    case 'status':
    case 'tab.state':
      return TIMEOUTS.statusMs;
    case 'ping':
      return TIMEOUTS.pingMs;
    case 'diagnostics':
      return TIMEOUTS.diagnosticsMs;
    case 'tab.find':
      return TIMEOUTS.findMs;
    case 'suggest':
      return TIMEOUTS.suggestMs;
    case 'cookies.list':
    case 'cookies.delete':
      return TIMEOUTS.cookiesMs;
    case 'siteData.clear':
      return TIMEOUTS.siteDataMs;
    case 'vpn.verify':
      return TIMEOUTS.vpnVerifyMs;
    default:
      return TIMEOUTS.commandMs;
  }
}

/** The optional capability a command needs (null for core commands). */
export function requiredCapability<T extends CommandType>(type: T, p: CommandPayload<T>): Capability | null {
  switch (type) {
    case 'tab.zoom':
      return 'zoom';
    case 'tab.action':
      return (p as CommandPayload<'tab.action'>).action;
    case 'tab.download':
      return (p as CommandPayload<'tab.download'>).kind === 'link' ? 'saveLink' : 'saveImage';
    case 'cookies.list':
    case 'cookies.delete':
      return 'cookies';
    case 'siteData.clear':
      return 'siteData';
    case 'suggest':
      return 'suggest';
    case 'vpn.verify':
      return 'vpnVerify';
    case 'blocker.stats':
    case 'blocker.reload':
      return 'blocker';
    default:
      return null;
  }
}

/**
 * Engine host: delay until needTicket{expiring} for a ticket received at `receivedAt` (both Unix ms on this
 * browser's clock; Ticket.expiresAt already is). Renews at TICKET.renewAtFraction of the remaining life, never sooner
 * than TICKET.minRenewDelayMs (also for a ticket that arrived expired, so renewals cannot loop), never later than the
 * setTimeout maximum.
 */
export function ticketRenewDelayMs(receivedAt: number, expiresAt: number): number {
  const life = expiresAt - receivedAt;
  if (!Number.isFinite(life) || life <= 0) return TICKET.minRenewDelayMs;
  const delay = Math.max(TICKET.minRenewDelayMs, life * TICKET.renewAtFraction);
  return Math.min(Math.floor(delay), 2 ** 31 - 1);
}

/**
 * App: Ticket.expiresAt on this browser's clock for a `POST /api/wisp/ticket` answer received at `receivedAt`
 * (`Date.now()`). The remaining life is measured against the server's own clock (the response's `Date` header, minus
 * TICKET.clockMarginMs for its 1-second resolution), so a device clock that runs ahead or behind changes nothing;
 * without a usable `Date` it falls back to this clock. The life is capped at `maxTtlMs` (`/api/config` →
 * `wisp.ticket_ttl_s` · 1000) and never negative.
 */
export function ticketExpiresAtLocal(serverExpiresAt: number, dateHeader: string | null, receivedAt: number, maxTtlMs: number): number {
  const serverNow = dateHeader === null ? Number.NaN : Date.parse(dateHeader);
  const life = Number.isFinite(serverNow) ? serverExpiresAt - serverNow - TICKET.clockMarginMs : serverExpiresAt - receivedAt;
  const capped = Math.min(Number.isFinite(life) ? life : 0, Number.isFinite(maxTtlMs) ? maxTtlMs : 0);
  return receivedAt + Math.max(0, Math.floor(capped));
}

/**
 * App: EngineSettings.engine from `browser.engine`, the operator's default (`/api/config` → `engines.default`,
 * GNOME_ENGINE_DEFAULT) and the engines the server offers. `auto` means "the server's default": Scramjet → `auto`
 * (Scramjet first, controlled fallback to Ultraviolet); Ultraviolet → `ultraviolet` (no automatic fallback, the
 * error overlay offers Scramjet). A chosen engine the server disables gives way to the one it offers.
 */
export function engineChoice(browserEngine: 'auto' | EngineId, serverDefault: EngineId, engines: Readonly<Record<EngineId, boolean>>): 'auto' | EngineId {
  if (engines.scramjet !== engines.ultraviolet) return engines.scramjet ? 'scramjet' : 'ultraviolet';
  if (browserEngine !== 'auto') return browserEngine;
  return serverDefault === 'ultraviolet' ? 'ultraviolet' : 'auto';
}

/** The rate-limit scope of an event: its tab, its download, or the whole port. */
export function eventScope(msg: AnyEventMessage): string {
  const p = msg.p as unknown as Record<string, unknown>;
  if (msg.type === 'download.progress' || msg.type === 'download.done') return `download:${String(p.downloadId)}`;
  if (msg.type === 'tab.openRequest') return `tab:${String(p.openerTabId)}`;
  if (typeof p.tabId === 'number') return `tab:${p.tabId}`;
  return 'port';
}

/**
 * Token buckets (app side): `take()` returns false when the event must be dropped. Buckets are created on first use
 * and the least recently used ones are evicted beyond `maxKeys`; call `forget(scope)` when a tab or download ends.
 */
export class TokenBuckets {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #maxKeys: number;

  constructor(maxKeys = 4096) {
    this.#maxKeys = maxKeys;
  }

  take(key: string, limit: RateLimit, now: number): boolean {
    let b = this.#buckets.get(key);
    if (b) {
      this.#buckets.delete(key); // re-insert: Map order is the LRU order
      b.tokens = Math.min(limit.burst, b.tokens + (Math.max(0, now - b.at) / 1000) * limit.perSecond);
      b.at = now;
    } else {
      b = { tokens: limit.burst, at: now };
      if (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next();
        if (!oldest.done) this.#buckets.delete(oldest.value);
      }
    }
    this.#buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drops every bucket whose key ends with `|<scope>` or equals `scope`. */
  forget(scope: string): void {
    for (const key of [...this.#buckets.keys()]) if (key === scope || key.endsWith(`|${scope}`)) this.#buckets.delete(key);
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * App side: the two-stage limit for one received event (EVENT_FLOOD_LIMIT for the port, then the per-type bucket of
 * its scope). Returns true when the event may be processed.
 */
export function admitEvent(buckets: TokenBuckets, msg: AnyEventMessage, now: number): boolean {
  if (!buckets.take('flood|port', EVENT_FLOOD_LIMIT, now)) return false;
  return buckets.take(`${msg.type}|${eventScope(msg)}`, EVENT_RATE_LIMITS[msg.type], now);
}
