/**
 * Proxy-origin runtime contract: paths, the pinned engine builds served from /vendor/**, the Content-Security-Policies,
 * the WebRTC kill switch, and the messages between the engine host and the service worker. Used by the engine-host
 * core (Wave B lane a), the transport/SW/build lane (b), and mirrored in Rust by gnome-server (lane e: the CSP strings
 * below are what its responses must carry; the e2e suite compares them).
 *
 * Verified in the two-origin spike (docs/research/spike-engine-host.md): the proxied-document CSP (§5.3), the
 * engine-host CSP (§5.4; served by the real gnome-server in §12), the bare-mux worker policy (§12), the SW contract
 * (§4.11), the vendor layout (§4.1). Proven in Wave B step 2 on the real gnome-server, in Chromium and Firefox: the
 * custom-Wisp opt-in policies (all four engine × transport pairs load through a custom Wisp server with the opt-in,
 * and the same route is blocked without it: backend-proxy `custom`), the script, worker-script and inert policies
 * below (backend-proxy `headers`, `realm`, `worker`), SW signals over `Client.postMessage` (lane b's sw suite), the
 * kill switch installed through the engines' own document-start hooks (host-webrtc; the spike modelled it with a
 * browser init script; its measured gaps are in ENGINE-PROTOCOL §6.15), and download detection by MIME type
 * (host-downloads `zip-without-disposition`; the spike detected attachments only). Evidence: the lanes' final runs
 * (2026-11-12) until integration part 2 reruns every suite.
 *
 * Custom Wisp servers (`browser.wispServers`) and these policies (decisions log 2026-11-11): the CSP is sent by the
 * server, so it cannot vary per user, and no URL parameter may widen a policy of the proxy origin (escaped code can
 * load any same-origin document in a hidden frame and use that realm's policy). The operator decides with
 * `GNOME_ALLOW_CUSTOM_WISP` (default off; `/api/config` → `wisp.custom_servers`): off, the engine host and the
 * bare-mux worker reach only their own origin and the app never sends a `custom` route; on, both policies add
 * `ws: wss:` and Settings warns that custom servers bypass the gateway, its access rules, VPN profiles and part of
 * the leak protection.
 */

import { BLOCK_CATEGORIES, BLOCKER_GROUPS, fitText } from './engine-protocol';
import type { BlockCategory, BlockerGroup, EngineId, SwStatus, TransportKind } from './engine-protocol';

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROXY_PATHS = {
  engineHost: '/engine/',
  serviceWorker: '/sw.js',
  /** GNOME's own UV config (loaded by the engine host, the SW and every UV document) and UV document-start hook. */
  uvConfig: '/engine/uv.config.js',
  uvDocumentHook: '/engine/uv-doc-hook.js',
  wisp: '/wisp/',
  /** The engine prefixes gnome-server answers with its retry page when the SW was not in control (one constant). */
  scramjetPrefix: '/~/sj/',
  ultravioletPrefix: '/uv/service/',
} as const;

export const ENGINE_PREFIXES: readonly string[] = [PROXY_PATHS.scramjetPrefix, PROXY_PATHS.ultravioletPrefix];

/** The pinned engine and transport builds (ARCHITECTURE §5.4), copied unmodified into dist/vendor/<dir>/. */
export interface VendorPackage {
  /** Directory under /vendor/. */
  dir: string;
  /** npm package (an alias for the second copy of a transport family). */
  pkg: string;
  /** Exact version; frontend/package.json pins the same. */
  version: string;
  /** Directory inside the package that is copied (with every file in it). */
  from: string;
  /** SPDX id from the package metadata or its LICENSE file (licenses.ts in the About page has the details). */
  license: string;
  /** The tarball ships no LICENSE file: copy-vendor writes the license text it states. */
  needsLicenseText: boolean;
}

export const VENDOR_PACKAGES: readonly VendorPackage[] = [
  { dir: 'scramjet', pkg: '@mercuryworkshop/scramjet', version: '2.0.67-alpha.2', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: true },
  { dir: 'scramjet-controller', pkg: '@mercuryworkshop/scramjet-controller', version: '0.0.14', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: true },
  { dir: 'libcurl-transport', pkg: '@mercuryworkshop/libcurl-transport', version: '2.0.6', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: false },
  { dir: 'epoxy-transport', pkg: '@mercuryworkshop/epoxy-transport', version: '3.0.2', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: true },
  { dir: 'ultraviolet', pkg: '@titaniumnetwork-dev/ultraviolet', version: '3.2.10', from: 'dist', license: 'AGPL-3.0', needsLicenseText: false },
  { dir: 'bare-mux', pkg: '@mercuryworkshop/bare-mux', version: '2.1.9', from: 'dist', license: 'MIT', needsLicenseText: false },
  { dir: 'libcurl-transport-bare', pkg: 'libcurl-transport-bare', version: '1.5.2', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: false },
  { dir: 'epoxy-transport-bare', pkg: 'epoxy-transport-bare', version: '2.1.29', from: 'dist', license: 'AGPL-3.0-only', needsLicenseText: true },
];

export const VENDOR = {
  scramjet: '/vendor/scramjet/scramjet.js',
  scramjetWasm: '/vendor/scramjet/scramjet.wasm',
  controllerApi: '/vendor/scramjet-controller/controller.api.js',
  controllerInject: '/vendor/scramjet-controller/controller.inject.js',
  controllerSw: '/vendor/scramjet-controller/controller.sw.js',
  bareMux: '/vendor/bare-mux/index.js',
  bareMuxWorker: '/vendor/bare-mux/worker.js',
  uvBundle: '/vendor/ultraviolet/uv.bundle.js',
  uvClient: '/vendor/ultraviolet/uv.client.js',
  uvHandler: '/vendor/ultraviolet/uv.handler.js',
  uvSw: '/vendor/ultraviolet/uv.sw.js',
} as const;

/** Transport modules (ES modules, dynamically imported) per engine and kind. */
export const TRANSPORT_MODULES: Readonly<Record<EngineId, Readonly<Record<TransportKind, string>>>> = {
  scramjet: { libcurl: '/vendor/libcurl-transport/index.mjs', epoxy: '/vendor/epoxy-transport/index.mjs' },
  ultraviolet: { libcurl: '/vendor/libcurl-transport-bare/index.mjs', epoxy: '/vendor/epoxy-transport-bare/index.mjs' },
};

/**
 * Classic scripts of the engine-host page, in this order (scramjet.js before controller.api.js), before the
 * engine-host module. frontend/engine/index.html must match; the build lane's test checks it.
 */
export const ENGINE_HOST_SCRIPTS: readonly string[] = [VENDOR.scramjet, VENDOR.controllerApi, VENDOR.bareMux, VENDOR.uvBundle, PROXY_PATHS.uvConfig];

/** The service worker's importScripts, in this order (after neutralizing skipWaiting, see ARCHITECTURE §5.4). */
export const SW_IMPORTS: readonly string[] = [VENDOR.controllerSw, VENDOR.uvBundle, PROXY_PATHS.uvConfig, VENDOR.uvSw];

// ── Content-Security-Policies ────────────────────────────────────────────────────────────────────────────────────

/**
 * Set on every proxied response with a navigable destination (any content type) and on proxied worker scripts, by
 * Scramjet's per-tab plugin (`fetch.response`) and the SW's UV `response` handler. Hard-wired: no runtime or settings
 * switch, and never a report-uri/report-to (reports would carry the user's browsing to a server): violations are
 * counted in the engine host with `securitypolicyviolation` and reported as blocked direct connections.
 * `blob:` in connect-src (integration part 2, `host-leak probe`): Ultraviolet's service worker fetches the blob: URLs a
 * page makes (its images, workers, fetch(blob:)), and /sw.js runs under proxyScriptCsp, i.e. this policy; a blob: URL
 * resolves from the proxy origin's own blob store, so no request leaves the browser.
 */
export const PROXIED_DOCUMENT_CSP =
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' blob:; form-action 'self'";

/**
 * Destinations that get PROXIED_DOCUMENT_CSP (the spike set it only for document/iframe + text/html). `object` and
 * `embed` matter only to Scramjet's window-side plugin: browsers never route plugin loads through a service worker, so
 * the SW never sees them (an `<object>`/`<embed>` of a proxied URL gets gnome-server's engine-prefix 503 page, whose
 * own policy is strict).
 */
export const CSP_DESTINATIONS: readonly string[] = ['document', 'iframe', 'frame', 'object', 'embed', 'worker', 'sharedworker'];

export function needsProxiedCsp(destination: string): boolean {
  return CSP_DESTINATIONS.includes(destination);
}

/**
 * Directives of the engine-host document after `frame-ancestors`. `blob:` in connect-src: Scramjet's controller resolves
 * a page's blob: URL by fetching it in the engine host (integration part 2, `host-leak probe`; local, no network).
 */
export const ENGINE_HOST_CSP_DIRECTIVES =
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self' data: blob:; form-action 'self'";

/** The operator's custom-Wisp opt-in (`GNOME_ALLOW_CUSTOM_WISP`, `/api/config` → `wisp.custom_servers`). */
export interface ProxyPolicyOptions {
  customWisp: boolean;
}

/** What the custom-Wisp opt-in adds to `connect-src` (any ws/wss host: the user picks the servers). */
export const CUSTOM_WISP_CONNECT_SOURCES = 'ws: wss:';

/**
 * The exact policy gnome-server sends with `/engine/` documents: frame-ancestors = the app origins, and `connect-src`
 * extended by `ws: wss:` only when the operator allows custom Wisp servers. `data:` in connect-src: libcurl-transport's
 * Emscripten loader fetches its wasm from a data: URL. The same for every request: no query parameter changes it.
 */
export function engineHostCsp(appOrigins: readonly string[], opts: ProxyPolicyOptions = { customWisp: false }): string {
  const extra = opts.customWisp ? ` ${CUSTOM_WISP_CONNECT_SOURCES}` : '';
  return `frame-ancestors ${appOrigins.length ? appOrigins.join(' ') : "'none'"}; ${ENGINE_HOST_CSP_DIRECTIVES.replace(
    "connect-src 'self' data: blob:",
    `connect-src 'self' data: blob:${extra}`,
  )}`;
}

/**
 * Policy of `/vendor/bare-mux/worker.js`: UV's transport SharedWorker accepts transport code from any same-origin
 * client, so it must not reach the network directly. Verified on the real gnome-server (spike §12): UV over epoxy and
 * libcurl works in both browsers, a native fetch injected through `setManualTransport` is blocked, `data:` is not
 * needed. With the custom-Wisp opt-in it adds `ws: wss:` like the engine-host policy.
 * gnome-server sends it with bareMuxWorkerScriptCsp(appOrigins, opts) as a second policy: connect-src alone leaves the
 * worker (and the worker URL opened as a document) free to load scripts, images and frames from any host. Every policy
 * of a response is enforced, so the opt-in's ws: wss: is in both.
 */
export function bareMuxWorkerCsp(opts: ProxyPolicyOptions = { customWisp: false }): string {
  return `connect-src 'self'${opts.customWisp ? ` ${CUSTOM_WISP_CONNECT_SOURCES}` : ''}`;
}

/** `frame-ancestors` of proxy-origin answers other than the engine host: the engine host (`'self'`) and the app origins. */
function proxyFrameAncestors(appOrigins: readonly string[]): string {
  return `frame-ancestors ${["'self'", ...appOrigins].join(' ')}`;
}

/**
 * Every other proxy-origin script (`/sw.js`, `/assets/*.js`, `/vendor/**` scripts, `/engine/*.js`): escaped code can
 * run it as a worker or open it as a document, so it gets no more than a proxied document. appOrigins: [] in
 * single-origin mode. The custom-Wisp opt-in never changes it.
 */
export function proxyScriptCsp(appOrigins: readonly string[]): string {
  return `${PROXIED_DOCUMENT_CSP}; ${proxyFrameAncestors(appOrigins)}`;
}

/** Second policy of `/vendor/bare-mux/worker.js`: the script policy with the custom-Wisp opt-in's sources in connect-src. */
export function bareMuxWorkerScriptCsp(appOrigins: readonly string[], opts: ProxyPolicyOptions = { customWisp: false }): string {
  const p = proxyScriptCsp(appOrigins);
  return opts.customWisp ? p.replace("connect-src 'self' blob:", `connect-src 'self' blob: ${CUSTOM_WISP_CONNECT_SOURCES}`) : p;
}

/**
 * Every proxy-origin answer where nothing runs (JSON, 404s, `/api/health`, `/api/filters*`, styles, wasm, fonts,
 * images, text, other HTML). The SW's own pages (hold/503, blocked, refused; src/sw/pure.ts SW_PAGE_CSP) use the same
 * directives without `frame-ancestors`.
 */
export function proxyInertCsp(appOrigins: readonly string[]): string {
  return `default-src 'none'; form-action 'none'; base-uri 'none'; ${proxyFrameAncestors(appOrigins)}`;
}

/** The engine iframe's src: always `<proxy origin>/engine/` (no parameters). */
export function engineHostUrl(proxyOrigin: string): string {
  return `${new URL(proxyOrigin).origin}${PROXY_PATHS.engineHost}`;
}

// ── Downloads (Scramjet's per-tab tap in the engine host and UV's tap in the SW use the same rules) ───────────────

/**
 * MIME types both browsers render inline in a frame (bare, lower case; images only with the subtypes listed, any
 * `audio/` or `video/` type by prefix). A document or iframe response of another type is probably a download.
 * `application/pdf` is inline in both browsers' built-in viewers when they are enabled [unproven in proxied frames].
 */
export const INLINE_DOCUMENT_TYPES: readonly string[] = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/xml',
  'application/xml',
  'image/svg+xml',
  'application/json',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
];
const INLINE_PREFIXES = ['audio/', 'video/'];

/** The bare, lower-case MIME type of a Content-Type value (`text/html; charset=utf-8` → `text/html`), or null. */
export function bareMime(contentType: string | null): string | null {
  if (contentType === null) return null;
  const t = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,128}$/.test(t) ? t : null;
}

/**
 * How a navigation response (destination `document` or `iframe`) relates to downloads (ENGINE-PROTOCOL §6.9):
 * - `attachment` (`Content-Disposition: attachment`): the browser downloads it. The navigation ends as a download at
 *   once: no timeout, no fallback, no tab.loaded, download.started now.
 * - `unrendered-type` (a MIME type outside INLINE_DOCUMENT_TYPES): most likely a download, but browsers differ for
 *   some types (e.g. `text/markdown`). The timeout and the fallback stop at once; download.started follows when no
 *   document commits for the navigation within TIMEOUTS.downloadCommitMs, and if one commits it was a page.
 * - null: a page (also for a missing or unreadable Content-Type, which the browser sniffs).
 */
export type DownloadDisposition = 'attachment' | 'unrendered-type';
export function downloadDisposition(contentDisposition: string | null, contentType: string | null): DownloadDisposition | null {
  if (contentDisposition !== null && /^\s*attachment\s*(?:;|$)/i.test(contentDisposition)) return 'attachment';
  const mime = bareMime(contentType);
  if (mime === null) return null;
  return INLINE_DOCUMENT_TYPES.includes(mime) || INLINE_PREFIXES.some((p) => mime.startsWith(p)) ? null : 'unrendered-type';
}

const FILENAME_MAX = 255;

/**
 * The file name for download.started: RFC 6266 `filename*` (UTF-8 percent-encoded), else `filename`, else the last
 * path segment of `url`, else "download". Path separators become "_", controls and bidi controls are removed, and a
 * name over 255 characters is cut before its extension.
 */
export function downloadFilename(contentDisposition: string | null, url: string): string {
  let name = '';
  if (contentDisposition !== null) {
    const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(contentDisposition);
    if (star?.[2] && /^utf-8$/i.test(star[1]?.trim() ?? '')) {
      try {
        name = decodeURIComponent(star[2].trim());
      } catch {
        name = '';
      }
    }
    if (!name) {
      const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(contentDisposition);
      name = (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim() ?? '').trim();
    }
  }
  if (!name) {
    try {
      const last = new URL(url).pathname.split('/').pop() ?? '';
      name = decodeURIComponent(last);
    } catch {
      name = '';
    }
  }
  name = name
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[/\\]/g, '_')
    .trim()
    .replace(/^\.+$/, '');
  if (!name) return 'download';
  if (name.length <= FILENAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  return fitText(name.slice(0, name.length - ext.length), FILENAME_MAX - ext.length) + ext;
}

// ── WebRTC kill switch ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Globals replaced with `undefined` (non-writable, non-configurable) at document start in every proxied window
 * (Scramjet `init.pre`, the UV document-start hook) and in the engine-host realm when `privacy.webrtc` is `block`.
 * Escaped code can still create a native about:blank realm the hooks never see: only connection-level blocking would
 * close that, which a website cannot do (ENGINE-PROTOCOL §1).
 */
export const WEBRTC_GLOBALS: readonly string[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'RTCDataChannel',
  'RTCIceCandidate',
  'RTCSessionDescription',
];

// ── Engine host ⇄ service worker ─────────────────────────────────────────────────────────────────────────────────

/**
 * Engine host → SW (`postMessage` on registration.active / .waiting). The SW acts on them only when `event.source`
 * is a window client whose URL is the engine host (isEngineHostClientUrl); ordinary proxied pages have no
 * `navigator.serviceWorker`, and an escaped page owns the whole proxy origin anyway. The SW takes no security
 * configuration: the CSP, the routing and the WebRTC policy are constants of its build. The only runtime input is the
 * content blocker's user settings (Wave B step 3).
 */
export type HostToSwMessage =
  /** A forced reload loaded the engine host uncontrolled: clients.claim(). */
  | { type: 'gnome-claim' }
  /** Sent to the waiting worker at engine-host startup, before engines exist, when this is the only engine host. */
  | { type: 'gnome-skip-waiting' }
  /** Asks for sw-hello (build id). */
  | { type: 'gnome-hello' }
  /**
   * Content-blocking settings for the SW's UV hooks: validate `settings` with validateEngineSettings. `setId`: the set
   * key K (WAVE-B3 §4.3) of the engines in force at that engine host, null while it has none (absent from an older
   * engine host: null). Sent at once after every `settings` command, every swap and on sw-hello.
   */
  | { type: 'gnome-blocker-config'; settings: unknown; setId: string | null }
  /**
   * The serialized group engines of set `setId` (FiltersEngine.serialize output, one per group in force), sent by an
   * engine host that has at least one Ultraviolet tab: after each swap, when its first UV tab opens, and on sw-hello.
   */
  | { type: 'gnome-blocker-engines'; setId: string; groups: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> }
  /**
   * The top-level page of UV documents (WAVE-B3 D15): `docs` = [proxied document URL, real top-level URL] of documents
   * that started; `navs` = proxied URLs a UV tab's top document is about to load (judged as main_frame); `drop` =
   * announced navs that were cancelled; `reset` = forget what this engine host sent before (sent after sw-hello, with
   * everything it knows, split into one `reset: true` message and as many `reset: false` messages as the limits need).
   * `inits` (optional, absent = []): [proxied URL, initiator] of loads and fetches the engine host itself starts in
   * Ultraviolet: '' for GNOME's own navigations (address bar, bookmark, history, reload, back/forward, restore: no
   * initiator, like a browser's), the opener's real URL for a tab a page asked for (tab.create start.opener), the
   * page's real URL for a fetch the engine host makes for a page (its favicon, a download it started). One-shot per
   * URL, forgotten after 30 s. The SW uses them only for SameSite and fetch metadata (lane x3's SameSite glue).
   */
  | { type: 'gnome-blocker-context'; docs: Array<[string, string]>; navs: string[]; drop: string[]; inits?: Array<[string, string]>; reset: boolean };

export const BLOCKER_CONTEXT_LIMITS = { docs: 512, navs: 64, urlLength: 8192 } as const;
/** Per message: at most one engine per group, 64 MiB each, 128 MiB in all. */
export const BLOCKER_ENGINE_LIMITS = { groupBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 } as const;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * SW → engine host, with `Client.postMessage` to every engine-host window client, never a BroadcastChannel (any
 * proxied page can join those). Several engine hosts can be open (one per GNOME tab): each attributes downloads and
 * errors only to its own tabs, by an exact match (ENGINE-PROTOCOL §6.9), and ignores the rest.
 *
 * `uv-download` is sent for a UV response to a request with `mode: 'navigate'` (never for a page's own fetch/XHR, which
 * the page reads itself) when downloadDisposition() is not null, and for every download request (`<a download>`).
 */
export type SwSignal =
  | { type: 'sw-hello'; build: string; startedAt: number }
  | { type: 'sw-held'; ms: number }
  | { type: 'sw-unavailable'; reason: 'not-routable' | 'stale-prefix' }
  | { type: 'uv-error'; url: string; message: string }
  | {
      type: 'uv-download';
      phase: 'started';
      id: string;
      /** The response's proxied URL (the engine host decodes it). */
      url: string;
      /** The request's referrer, proxied (null under `Referrer-Policy: no-referrer` and for `rel=noreferrer` links). */
      referrer: string | null;
      /** URL of the requesting client when the fetch event has a `clientId` (download requests in some browsers), else null. */
      clientUrl: string | null;
      /**
       * true: a frame navigation (destination `document` or `iframe`): it ends that frame's pending navigation as a
       * download. false: a download request (`<a download>`, empty destination): the document stays and nothing
       * else about the tab changes.
       */
      navigation: boolean;
      /** Which rule made it a download (`<a download>` requests are `attachment`). */
      disposition: DownloadDisposition;
      filename: string;
      mime: string | null;
      total: number | null;
    }
  | { type: 'uv-download'; phase: 'progress'; id: string; received: number; total: number | null }
  | { type: 'uv-download'; phase: 'done'; id: string; state: 'completed' | 'failed' | 'cancelled'; received: number; error: string | null }
  /**
   * Wave B step 3: requests of one UV document were blocked since the last report (the SW batches per document, at
   * most one message per document per 250 ms). `documentUrl`: the requesting document's proxied URL as the SW
   * recorded it at its navigation; the engine host maps it to a tab (its own map of the UV documents it attached).
   * Counting only: a blocked UV tab navigation is recognized from the frame load (WAVE-B3 §4.4).
   */
  | { type: 'uv-blocked'; documentUrl: string; counts: Partial<Record<BlockCategory, number>> };

/** SW side: whether a message source is the engine host (same origin, path exactly /engine/; a query is ignored). */
export function isEngineHostClientUrl(clientUrl: string, swOrigin: string): boolean {
  try {
    const u = new URL(clientUrl);
    return u.origin === swOrigin && u.pathname === PROXY_PATHS.engineHost;
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const natOrNull = (v: unknown): v is number | null => v === null || nat(v);
const strOrNull = (v: unknown, max: number): v is string | null => v === null || str(v, max);
const ID = /^[A-Za-z0-9._-]{1,64}$/;

/** SW side: a message from the engine host, or null. */
export function parseHostToSw(data: unknown): HostToSwMessage | null {
  if (!isObj(data)) return null;
  if (data.type === 'gnome-blocker-config') {
    if (!isObj(data.settings)) return null;
    const id = data.setId;
    return { type: 'gnome-blocker-config', settings: data.settings, setId: typeof id === 'string' && HEX64.test(id) ? id : null };
  }
  if (data.type === 'gnome-blocker-engines') {
    const { setId, groups } = data;
    if (typeof setId !== 'string' || !HEX64.test(setId) || !Array.isArray(groups) || groups.length > BLOCKER_GROUPS.length) return null;
    const seen = new Set<BlockerGroup>();
    const out: Array<{ group: BlockerGroup; bytes: ArrayBuffer }> = [];
    let total = 0;
    for (const g of groups as unknown[]) {
      if (!isObj(g) || !(g.bytes instanceof ArrayBuffer) || typeof g.group !== 'string') return null;
      const group = g.group as BlockerGroup;
      if (!BLOCKER_GROUPS.includes(group) || seen.has(group)) return null;
      if (g.bytes.byteLength === 0 || g.bytes.byteLength > BLOCKER_ENGINE_LIMITS.groupBytes) return null;
      total += g.bytes.byteLength;
      if (total > BLOCKER_ENGINE_LIMITS.totalBytes) return null;
      seen.add(group);
      out.push({ group, bytes: g.bytes });
    }
    return { type: 'gnome-blocker-engines', setId, groups: out };
  }
  if (data.type === 'gnome-blocker-context') {
    const { docs, navs, reset } = data;
    const drop = data.drop === undefined ? [] : data.drop;
    if (!Array.isArray(docs) || docs.length > BLOCKER_CONTEXT_LIMITS.docs) return null;
    if (!Array.isArray(navs) || navs.length > BLOCKER_CONTEXT_LIMITS.navs || typeof reset !== 'boolean') return null;
    if (!Array.isArray(drop) || drop.length > BLOCKER_CONTEXT_LIMITS.navs) return null;
    const url = (u: unknown): u is string => str(u, BLOCKER_CONTEXT_LIMITS.urlLength) && u.length > 0;
    const pairs: Array<[string, string]> = [];
    for (const d of docs as unknown[]) {
      if (!Array.isArray(d) || d.length !== 2 || !url(d[0]) || !url(d[1])) return null;
      pairs.push([d[0], d[1]]);
    }
    if (!(navs as unknown[]).every(url) || !(drop as unknown[]).every(url)) return null;
    const inits = data.inits === undefined ? [] : data.inits;
    if (!Array.isArray(inits) || inits.length > BLOCKER_CONTEXT_LIMITS.navs) return null;
    const initPairs: Array<[string, string]> = [];
    for (const i of inits as unknown[]) {
      if (!Array.isArray(i) || i.length !== 2 || !url(i[0]) || !(i[1] === '' || url(i[1]))) return null;
      initPairs.push([i[0], i[1]]);
    }
    return { type: 'gnome-blocker-context', docs: pairs, navs: [...(navs as string[])], drop: [...(drop as string[])], inits: initPairs, reset };
  }
  return data.type === 'gnome-claim' || data.type === 'gnome-skip-waiting' || data.type === 'gnome-hello'
    ? { type: data.type }
    : null;
}

/** Engine-host side: a SW signal with only the documented fields, or null (dropped). */
export function parseSwSignal(data: unknown): SwSignal | null {
  if (!isObj(data)) return null;
  const d = data;
  switch (d.type) {
    case 'sw-hello':
      return str(d.build, 64) && nat(d.startedAt) ? { type: 'sw-hello', build: d.build, startedAt: d.startedAt } : null;
    case 'sw-held':
      return nat(d.ms) ? { type: 'sw-held', ms: d.ms } : null;
    case 'sw-unavailable':
      return d.reason === 'not-routable' || d.reason === 'stale-prefix' ? { type: 'sw-unavailable', reason: d.reason } : null;
    case 'uv-error':
      return str(d.url, 8192) && str(d.message, 500) ? { type: 'uv-error', url: d.url, message: d.message } : null;
    case 'uv-blocked': {
      if (!str(d.documentUrl, 8192)) return null;
      const counts: Partial<Record<BlockCategory, number>> = {};
      const known = (c: unknown): c is BlockCategory => typeof c === 'string' && (BLOCK_CATEGORIES as readonly string[]).includes(c);
      if (known(d.category)) counts[d.category] = 1;
      else if (isObj(d.counts)) {
        for (const [k, v] of Object.entries(d.counts)) {
          if (!known(k) || !nat(v) || v === 0 || v > 100_000) return null;
          counts[k] = v;
        }
      } else return null;
      return Object.keys(counts).length ? { type: 'uv-blocked', documentUrl: d.documentUrl, counts } : null;
    }
    case 'uv-download': {
      if (!str(d.id, 64) || !ID.test(d.id)) return null;
      if (d.phase === 'started') {
        return str(d.url, 8192) &&
          strOrNull(d.referrer, 8192) &&
          strOrNull(d.clientUrl, 8192) &&
          typeof d.navigation === 'boolean' &&
          (d.disposition === 'attachment' || d.disposition === 'unrendered-type') &&
          str(d.filename, 255) &&
          strOrNull(d.mime, 200) &&
          natOrNull(d.total)
          ? {
              type: 'uv-download',
              phase: 'started',
              id: d.id,
              url: d.url,
              referrer: d.referrer,
              clientUrl: d.clientUrl,
              navigation: d.navigation,
              disposition: d.disposition,
              filename: d.filename,
              mime: d.mime,
              total: d.total,
            }
          : null;
      }
      if (d.phase === 'progress') {
        return nat(d.received) && natOrNull(d.total) ? { type: 'uv-download', phase: 'progress', id: d.id, received: d.received, total: d.total } : null;
      }
      if (d.phase === 'done') {
        const state = d.state;
        return (state === 'completed' || state === 'failed' || state === 'cancelled') && nat(d.received) && strOrNull(d.error, 300)
          ? { type: 'uv-download', phase: 'done', id: d.id, state, received: d.received, error: d.error }
          : null;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Service-worker side of the engine host (lane b implements, lane a calls). */
export interface SwClient {
  /**
   * Registers /sw.js (scope `/`, `updateViaCache: 'none'`). When a newer worker is waiting and no other engine host
   * is open, activates it first (the explicit "apply update" step: Firefox keeps the old worker across reloads).
   * Claims an uncontrolled load (forced reload). Resolves once a controller exists; rejects with an Error whose
   * `code` is `insecure_context` or `sw_timeout`.
   */
  ensureControlled(): Promise<SwStatus>;
  status(): SwStatus;
  onStatus(listener: (status: SwStatus) => void): () => void;
  onSignal(listener: (signal: SwSignal) => void): () => void;
  /** The active worker (Scramjet's Controller is built with it and re-pointed on change). */
  controller(): ServiceWorker | null;
  onControllerChange(listener: (controller: ServiceWorker) => void): () => void;
  diagnostics(): { starts: number; held: number; unavailable: number };
  /**
   * Engine host → SW (gnome-blocker-config, -context, -engines): to the active worker; dropped while there is none.
   * `transfer` is not used for engine bytes (the engine host keeps its own copy: its engines are views into them).
   */
  post(message: HostToSwMessage): void;
}
