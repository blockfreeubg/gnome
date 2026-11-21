/**
 * Engine-host transport contract (Wave B lane b provides it, lane a consumes it). Runs on the proxy origin only.
 *
 * The rules come from the two-origin spike (docs/research/spike-engine-host.md §4.5–§4.6 and §6) and API.md "Wisp":
 * - One URL form for every transport: `<route>?t=<ticket>&/` (libcurl refuses URLs that do not end in "/"; the gateway
 *   ignores the empty pair). Tickets go only to the proxy origin, never to other Wisp servers.
 * - Build a transport, `await init()`, and only then hand it to an engine. Every (re)build goes through one queue:
 *   concurrent libcurl `init()` calls hang.
 * - Watchdog: libcurl reconnects by itself with the URL it was built with, so after a drop probe once (renew on 401);
 *   epoxy never reconnects, so probe and then rebuild (426), renew (401) or back off (network error, 429, 503). The
 *   probe never contacts the upstream: the gateway answers `503 wisp_upstream_unavailable` (+ Retry-After) while its
 *   health job has the route's upstream down, and a socket that fails to open right after a 426 means the same
 *   (HolyWisp or the VPN location's instance is down: spike §12). Either way that side goes `offline` /
 *   `upstream-unreachable` and backs off like a network error instead of rebuilding after every 426. A 404 means the
 *   VPN profile is gone (`unknown-profile`: the app picks the route again). VPN location status comes from the app
 *   (`/api/vpn/locations`).
 * - Lazy renewal: a new ticket rebuilds libcurl transports (cheap) and anything not `ready`; a healthy epoxy transport
 *   keeps its socket (no transport has a close API: rebuilding it would leak a Wisp connection against the 16 per
 *   session) and uses the new ticket at its next rebuild. Tickets are checked only at the upgrade.
 * - Rebuilds are capped per side (RECOVERY.rebuildLimit per rebuildWindowMs); beyond the cap the side is `offline`
 *   with `rebuild-limit` until the window passes.
 * - One Ultraviolet transport per proxy origin: every engine host of the browser (one per open GNOME tab) shares
 *   bare-mux's single SharedWorker (`bare-mux-worker`, its path kept in localStorage `bare-mux-path`), so the
 *   transport the last `setManualTransport()` installed carries the UV traffic of all of them (ENGINE-PROTOCOL §6.6).
 *   A manager installs it only (1) in start() when the worker has no transport or one of another route or kind,
 *   (2) in configure(), because its app's settings changed (the newest settings win: the app syncs settings across
 *   its tabs, so the others follow), and (3) to rebuild, after a probe, a transport of its own route and kind (or
 *   when the worker runs none): uvTransportAction(). It never replaces a transport of another route because a check
 *   found it different: a GNOME tab whose settings are a moment old must not undo a route change (the VPN kill
 *   switch) made in another. Every engine host receives the socket tap's events, not only the one that installed it,
 *   so the UV watchdog keeps working when that GNOME tab closes. Scramjet's transport lives in each engine host's own
 *   realm and is not shared.
 * Pure helpers below are unit-tested; the manager itself is lane b's.
 */

import type { EngineId, NeedTicketReason, Ticket, TransportKind, TransportStatus, WispRoute } from './engine-protocol.ts';
import type { RequestHooks } from './engine-hooks.ts';

export const RECOVERY = {
  /** Probe backoff: base·2ⁿ, capped, ±jitter. */
  probeBackoffBaseMs: 250,
  probeBackoffMaxMs: 30_000,
  probeJitter: 0.5,
  /** Attempts in one recovery run; after that one attempt every idleRetryMs (and on the next navigation). */
  probeAttempts: 12,
  idleRetryMs: 60_000,
  /** Transport (re)builds allowed per engine side in a rolling window. */
  rebuildLimit: 6,
  rebuildWindowMs: 60_000,
  /** A 429 probe answer without a usable Retry-After waits this long; any Retry-After is capped at the max. */
  rateLimitDefaultMs: 60_000,
  rateLimitMaxMs: 600_000,
  /** reportFailure() probes at most this often per side. */
  failureProbeMinIntervalMs: 2_000,
  /** transport.init(), bare-mux setManualTransport() and Scramjet's controller.wait() each get this long. */
  initTimeoutMs: 10_000,
} as const;

/** `base`·2ⁿ capped at the max, times a jitter factor in [1 − j, 1 + j). `random` in [0, 1) (injectable for tests). */
export function backoffDelayMs(attempt: number, random: number = Math.random()): number {
  const raw = Math.min(RECOVERY.probeBackoffMaxMs, RECOVERY.probeBackoffBaseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 - RECOVERY.probeJitter + 2 * RECOVERY.probeJitter * Math.min(Math.max(random, 0), 1)));
}

/** Rolling-window rebuild cap for one engine side. */
export class RebuildBudget {
  readonly #times: number[] = [];

  /** Records a rebuild and returns true, or returns false when the cap is reached. */
  tryTake(now: number): boolean {
    while (this.#times.length && now - (this.#times[0] ?? now) >= RECOVERY.rebuildWindowMs) this.#times.shift();
    if (this.#times.length >= RECOVERY.rebuildLimit) return false;
    this.#times.push(now);
    return true;
  }

  /** ms until the next rebuild is allowed (0 = now). */
  waitMs(now: number): number {
    if (this.#times.length < RECOVERY.rebuildLimit) return 0;
    return Math.max(0, (this.#times[0] ?? now) + RECOVERY.rebuildWindowMs - now);
  }
}

// ── Endpoints and URLs ───────────────────────────────────────────────────────────────────────────────────────────

export interface WispEndpoint {
  /** ws(s):// URL without a ticket. */
  url: string;
  /** On the proxy origin: gets the ticket and supports the 401/426 probe (API.md "Ticket probe"). */
  gateway: boolean;
  kind: 'default' | 'profile' | 'custom';
}

export type EndpointProblem = 'mixed-content' | 'not-wisp-path' | 'invalid';

/**
 * The endpoints of a route, in the order the transport manager tries them, plus the entries it must skip (custom
 * servers only): `ws:` from an https proxy origin is blocked as mixed content, and a Wisp v2 endpoint's path ends in
 * "/" (the protocol reads anything after the last "/" as a wsproxy target).
 */
export function routeEndpoints(
  route: WispRoute,
  proxyOrigin: string,
): { endpoints: WispEndpoint[]; skipped: Array<{ server: string; problem: EndpointProblem }> } {
  const origin = new URL(proxyOrigin);
  const wsOrigin = `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  if (route.kind === 'default') return { endpoints: [{ url: `${wsOrigin}/wisp/`, gateway: true, kind: 'default' }], skipped: [] };
  if (route.kind === 'profile') {
    return { endpoints: [{ url: `${wsOrigin}/wisp/p/${encodeURIComponent(route.id)}/`, gateway: true, kind: 'profile' }], skipped: [] };
  }
  const endpoints: WispEndpoint[] = [];
  const skipped: Array<{ server: string; problem: EndpointProblem }> = [];
  for (const server of route.servers) {
    let u: URL;
    try {
      u = new URL(server.startsWith('/') ? `${wsOrigin}${server}` : server);
    } catch {
      skipped.push({ server, problem: 'invalid' });
      continue;
    }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      skipped.push({ server, problem: 'invalid' });
      continue;
    }
    if (u.protocol === 'ws:' && origin.protocol === 'https:') {
      skipped.push({ server, problem: 'mixed-content' });
      continue;
    }
    if (!u.pathname.endsWith('/')) {
      skipped.push({ server, problem: 'not-wisp-path' });
      continue;
    }
    u.hash = '';
    const gateway = `${u.protocol}//${u.host}` === wsOrigin && (u.pathname === '/wisp/' || /^\/wisp\/p\/[^/]+\/$/.test(u.pathname));
    endpoints.push({ url: u.href, gateway, kind: 'custom' });
  }
  return { endpoints, skipped };
}

/**
 * The URL a transport is built with. Gateway endpoints get `t=<ticket>` and end in `&/` (canonical form); other
 * servers are used as configured, except that a URL with a query gets a trailing `&/` so it still ends in "/".
 */
export function wispUrl(endpoint: WispEndpoint, ticket: string | null): string {
  const u = new URL(endpoint.url);
  if (endpoint.gateway && ticket) {
    const query = u.search ? `${u.search.slice(1).replace(/&\/$/, '')}&` : '';
    return `${u.origin}${u.pathname}?${query}t=${encodeURIComponent(ticket)}&/`;
  }
  if (u.search && !u.search.endsWith('/')) return `${u.href}&/`;
  return u.href;
}

/** The plain-GET probe of a gateway endpoint (same path and query, http(s) scheme); null for other servers. */
export function probeUrl(endpoint: WispEndpoint, ticket: string | null): string | null {
  if (!endpoint.gateway) return null;
  return wispUrl(endpoint, ticket).replace(/^ws(s?):/, 'http$1:');
}

/** Removes the ticket from a URL before it is logged or shown (diagnostics never carry tickets). */
export function redactTicket(url: string): string {
  return url.replace(/([?&]t=)[^&#]*/g, '$1<ticket>');
}

export type ProbeOutcome =
  /** 426: the ticket is valid and the gateway is up: rebuild the transport. */
  | { kind: 'valid' }
  /** 401: needTicket{rejected}; `code` is the wisp_ticket_* code from the body (null when unreadable). */
  | { kind: 'rejected'; code: string | null }
  /** 429 (probes share the 60/min upgrade budget): wait, never treat as "gateway down" or as a ticket problem. */
  | { kind: 'rate-limited'; retryAfterMs: number }
  /**
   * 503 `wisp_upstream_unavailable`: the gateway is up but the route's upstream is down (its health job says so):
   * `offline` / `upstream-unreachable`, next probe after `retryAfterMs` (Retry-After, else the probe backoff: null).
   */
  | { kind: 'upstream-down'; retryAfterMs: number | null }
  /** 404: the VPN profile is unknown (the app's profile list is stale): `offline` / `unknown-profile`. */
  | { kind: 'unknown-profile' }
  /** Network error, 502/504, any other 503 (shutting down) or anything unexpected: back off and probe again. */
  | { kind: 'unreachable'; status: number | null };

/** Retry-After in whole seconds (the only form gnome-server sends) as ms, capped; null when absent or unreadable. */
export function retryAfterMs(retryAfter: string | null): number | null {
  if (retryAfter === null || !/^\d{1,7}$/.test(retryAfter.trim())) return null;
  return Math.min(Math.max(Number(retryAfter.trim()) * 1000, 1000), RECOVERY.rateLimitMaxMs);
}

/** Classifies a probe answer (`status` null = the fetch failed at the network level; `errorCode` = body error.code). */
export function classifyProbe(status: number | null, retryAfter: string | null, errorCode: string | null): ProbeOutcome {
  if (status === null) return { kind: 'unreachable', status: null };
  if (status === 426) return { kind: 'valid' };
  if (status === 401) return { kind: 'rejected', code: errorCode && /^wisp_ticket_[a-z_]{1,32}$/.test(errorCode) ? errorCode : null };
  if (status === 429) return { kind: 'rate-limited', retryAfterMs: retryAfterMs(retryAfter) ?? RECOVERY.rateLimitDefaultMs };
  if (status === 503 && errorCode === 'wisp_upstream_unavailable') return { kind: 'upstream-down', retryAfterMs: retryAfterMs(retryAfter) };
  if (status === 404) return { kind: 'unknown-profile' };
  return { kind: 'unreachable', status };
}

// ── The shared Ultraviolet transport (one bare-mux SharedWorker per proxy origin) ────────────────────────────────

/** What a UV transport in the shared worker serves: its route and kind (never the ticket). */
export function uvTransportKey(route: WispRoute, transport: TransportKind): string {
  const target = route.kind === 'profile' ? route.id : route.kind === 'custom' ? route.servers.join(' ') : '';
  return `${transport}|${route.kind}|${target}`;
}

/** Why a manager considers (re)installing the shared UV transport. */
export type UvInstallReason =
  /** start(): this engine host just started. */
  | 'start'
  /** configure(): its app sent new settings (route or transport kind). */
  | 'configure'
  /** Its watchdog's probe says the transport must be rebuilt (426 after a drop, a new ticket for a dead socket). */
  | 'rebuild';

/**
 * Whether a manager calls setManualTransport() (the rules in the header): `installed` is the key of what the worker
 * runs now (null: nothing, e.g. after the SharedWorker restarted), `wanted` the key of this engine host's route and
 * kind. A rebuild never replaces a transport of another route: this host's settings are then the older ones, and its
 * app sends the new ones shortly.
 */
export function uvTransportAction(reason: UvInstallReason, installed: string | null, wanted: string): 'install' | 'keep' {
  if (reason === 'rebuild') return installed === null || installed === wanted ? 'install' : 'keep';
  return installed === wanted ? 'keep' : 'install';
}

// ── The manager (lane b implements, lane a calls) ────────────────────────────────────────────────────────────────

/** Scramjet's ProxyTransport instance (libcurl-transport 2.0.6 / epoxy-transport 3.0.2), opaque to the core. */
export type ScramjetTransport = object;

/** What the manager calls after every Scramjet transport rebuild: the Controller (`controller.setTransport`). */
export interface ScramjetTransportSink {
  setTransport(transport: ScramjetTransport): void;
}

export interface TransportOptions {
  /** Sides to run: an engine that is disabled or failed to load gets no transport. */
  sides: Record<EngineId, boolean>;
  route: WispRoute;
  transport: TransportKind;
  ticket: Ticket | null;
  /** location.origin of the engine host (the proxy origin). */
  proxyOrigin: string;
}

export interface ProxyFetchInit {
  method?: 'GET';
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Responses larger than this reject (suggestions: 64 KiB; VPN exit check: 16 KiB). */
  maxBytes: number;
}

export interface ProxyFetchResult {
  status: number;
  headers: Array<[string, string]>;
  body: ArrayBuffer;
}

export interface TransportDiagnostics {
  probes: { valid: number; rejected: number; unreachable: number; rateLimited: number; upstreamDown: number; unknownProfile: number };
  rebuilds: Record<EngineId, number>;
  drops: Record<EngineId, number>;
}

export interface TransportManager {
  /**
   * Builds and initializes the transport of every requested side (through the one rebuild queue). Never rejects: a
   * side that fails shows it in status(). Call once, before the engines are created.
   */
  start(opts: TransportOptions): Promise<void>;
  /** Scramjet's first transport, initialized (construct the Controller with it). Rejects when that side failed. */
  scramjetTransport(): Promise<ScramjetTransport>;
  /** The manager hands every later Scramjet transport to this sink. */
  bindScramjet(sink: ScramjetTransportSink): void;
  /**
   * Resolves once bare-mux runs a working transport for Ultraviolet (installed by this manager, or an equal one
   * another engine host installed in the shared worker); rejects when that side failed.
   */
  ultravioletReady(): Promise<void>;
  /** New route or transport kind (settings command): rebuilds what changed. */
  configure(opts: Pick<TransportOptions, 'route' | 'transport'>): Promise<void>;
  /** A new ticket (ticket command): lazy renewal as described above. */
  setTicket(ticket: Ticket): Promise<void>;
  status(): Record<EngineId, TransportStatus>;
  onStatus(listener: (status: Record<EngineId, TransportStatus>) => void): () => void;
  /**
   * The core turns this into the needTicket event: `expiring` at ticketRenewDelayMs() after each ticket (the manager
   * owns that timer), `rejected` after a 401 probe, `missing` when started without a ticket.
   */
  onNeedTicket(listener: (reason: NeedTicketReason) => void): () => void;
  /** A navigation failed in a way that may be the transport (error hook, UV transport error): probe now. */
  reportFailure(side: EngineId, detail: string): void;
  /**
   * WebSockets of Scramjet pages consult `hooks.onWebSocket` (Wave B step 3; ALLOW_ALL until then): the manager wraps
   * the Scramjet transport's connect in the engine-host realm. Ultraviolet's transport runs in the bare-mux
   * SharedWorker, where no synchronous call into the hooks is possible: UV pages are checked in their own realm by the
   * UV document-start hook (lane a, engine-hooks.ts).
   */
  useHooks(hooks: Pick<RequestHooks, 'onWebSocket'>): void;
  /**
   * A GET through Wisp without any engine: no cookies, no rewriting (search suggestions, the VPN exit check). Uses the
   * Scramjet-side transport, else Ultraviolet's through bare-mux.
   */
  proxyFetch(url: string, init: ProxyFetchInit): Promise<ProxyFetchResult>;
  diagnostics(): TransportDiagnostics;
}
