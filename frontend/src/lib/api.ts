/**
 * Typed fetch wrapper for the GNOME HTTP API (docs/API.md).
 *
 * - JSON in/out, `X-GNOME-Request: 1` on every non-GET/HEAD request (CSRF contract), same-origin cookies.
 * - Every failure becomes an ApiError with a typed `code` (server codes + network_error/timeout/aborted/…).
 * - Timeouts (default 15 s) combined with caller AbortSignals.
 * - ensureSession(): POST /api/session once per page (deduplicated), prompting for an access code in `code` mode
 *   and emitting `session:login-required` in `accounts` mode.
 */
import { appEvents } from './events';
import type { EngineId } from '../settings/schema';

/**
 * Every `error.code` docs/API.md ("Errors") lists for `/api/*` (the Wisp gateway's own codes reach the engine host, not
 * this client). `timeout` is the server's own 503 (no answer in 30 s); `unavailable` is a 503 with `Retry-After`
 * (e.g. filter lists not ready yet).
 */
export type ServerErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'payload_too_large'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'access_code_required'
  | 'login_required'
  | 'internal'
  | 'timeout'
  | 'unavailable';

/** Failures detected by the client itself (`timeout` also covers the client-side request timeout). */
export type ClientErrorCode = 'network_error' | 'timeout' | 'aborted' | 'invalid_response' | 'unknown';
export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

export const SERVER_ERROR_CODES: ReadonlySet<string> = new Set<ServerErrorCode>([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'payload_too_large',
  'quota_exceeded',
  'rate_limited',
  'access_code_required',
  'login_required',
  'internal',
  'timeout',
  'unavailable',
]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: Record<string, string> | undefined;
  readonly retryAfterS: number | undefined;
  /** For `conflict` responses: the server's body (e.g. the newer sync copy). */
  readonly body: unknown;
  /**
   * True when the response used GNOME's error envelope (`{"error": {"code", "message"}}`). False for network
   * failures and for answers from something else at this address (a reverse proxy error page, another app).
   */
  readonly fromGnome: boolean;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
    retryAfterS?: number;
    body?: unknown;
    fromGnome?: boolean;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields;
    this.retryAfterS = init.retryAfterS;
    this.body = init.body;
    this.fromGnome = init.fromGnome ?? false;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }

  /** True when retrying later could succeed (network, timeout, 429, 5xx). */
  get retryable(): boolean {
    return (
      this.code === 'network_error' ||
      this.code === 'timeout' ||
      this.code === 'rate_limited' ||
      (this.status >= 500 && this.status <= 599)
    );
  }
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, QueryValue>;
  /** JSON-serialized unless it is FormData/Blob/string. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Milliseconds; 0 disables. Default 15 000. */
  timeoutMs?: number;
  /** Called with the headers of a successful response, before its body is parsed (e.g. to read `Date`). */
  onHeaders?: (headers: Headers) => void;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Code for a response without GNOME's error envelope (a reverse proxy's or another app's answer). */
function statusToCode(status: number): ApiErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status === 504) return 'timeout';
  if (status >= 500) return 'internal';
  return 'unknown';
}

const DEFAULT_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  network_error: 'Could not reach the GNOME server.',
  timeout: 'The GNOME server took too long to answer.',
  aborted: 'The request was cancelled.',
  invalid_response: 'The GNOME server sent an unexpected response.',
  rate_limited: 'Too many requests. Try again shortly.',
  internal: 'The GNOME server hit an internal error.',
  not_found: 'Not found.',
  method_not_allowed: 'The GNOME server does not support this request.',
  forbidden: 'This action is not allowed.',
  unauthorized: 'You are not signed in.',
};

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal | undefined; timedOut: () => boolean } {
  if (!timeoutMs) return { signal, timedOut: () => false };
  const timeout = AbortSignal.timeout(timeoutMs);
  const timedOut = (): boolean => timeout.aborted && !(signal?.aborted ?? false);
  if (!signal) return { signal: timeout, timedOut };
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([signal, timeout]), timedOut };
  const ctrl = new AbortController();
  const abort = (): void => ctrl.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return { signal: ctrl.signal, timedOut };
}

/** The documented error body: `{"error": {"code": "snake_case", "message": "…", …}}` (docs/API.md). */
function errorEnvelope(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== 'object' || Array.isArray(err)) return null;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.message === 'string' ? e : null;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text();
  } catch {
    body = null;
  }
  const retryHeader = Number(res.headers.get('retry-after'));
  const err = errorEnvelope(body);
  const rawCode = typeof err?.code === 'string' ? err.code : '';
  const code: ApiErrorCode = SERVER_ERROR_CODES.has(rawCode) ? (rawCode as ServerErrorCode) : statusToCode(res.status);
  const message =
    (typeof err?.message === 'string' && err.message) || DEFAULT_MESSAGES[code] || `Request failed (${res.status}).`;
  const retryAfterS =
    typeof err?.retry_after_s === 'number' ? err.retry_after_s : Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
  const fields =
    err?.fields && typeof err.fields === 'object' && !Array.isArray(err.fields) ? (err.fields as Record<string, string>) : undefined;
  return new ApiError({
    status: res.status,
    code,
    message,
    ...(fields ? { fields } : {}),
    ...(retryAfterS !== undefined ? { retryAfterS } : {}),
    body,
    fromGnome: err !== null,
  });
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (method !== 'GET' && method !== 'HEAD') headers['X-GNOME-Request'] = '1';
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData || opts.body instanceof Blob || typeof opts.body === 'string') {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }
  const { signal, timedOut } = combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (cause) {
    const aborted = cause instanceof DOMException && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
    const code: ApiErrorCode = aborted ? (timedOut() ? 'timeout' : 'aborted') : 'network_error';
    throw new ApiError({ status: 0, code, message: DEFAULT_MESSAGES[code] ?? 'Request failed.', cause });
  }
  if (!res.ok) throw await parseError(res);
  opts.onHeaders?.(res.headers);
  if (res.status === 204 || method === 'HEAD') return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // The dev server answers unknown /api paths with index.html when no backend runs; treat as invalid.
    throw new ApiError({ status: res.status, code: 'invalid_response', message: DEFAULT_MESSAGES.invalid_response! });
  }
  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new ApiError({ status: res.status, code: 'invalid_response', message: DEFAULT_MESSAGES.invalid_response!, cause });
  }
}

export const api = {
  request,
  get: <T>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) => request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'DELETE', body }),
};

// ── Typed endpoints used by the shell ────────────────────────────────────────────────────────────────────────────

export interface WispProfileInfo {
  id: string;
  label: string;
  country_code: string;
  city: string;
  path: string;
}

/** GET /api/config (docs/API.md). */
export interface ServerConfig {
  version: string;
  access_mode: 'open' | 'code' | 'accounts';
  registration: 'open' | 'closed';
  features: { accounts: boolean; sync: boolean; games: boolean; vpn_gateway: boolean; thumb_proxy: boolean };
  wisp: {
    path: string;
    ticket_ttl_s: number;
    profiles: WispProfileInfo[];
    /**
     * The operator allows custom Wisp servers (`GNOME_ALLOW_CUSTOM_WISP`; false when a server omits it): only then do
     * the engine-host CSPs let the engine host reach other hosts, so only then may `browser.wispServers` be used.
     */
    custom_servers: boolean;
  };
  engines: { default: EngineId; scramjet: boolean; ultraviolet: boolean };
  /**
   * Origin that serves the engine host (`/engine/`) and Wisp; equals the app origin when `isolated` is false, and is
   * `null` when the server cannot tell which origin the request used.
   */
  proxy: { origin: string | null; isolated: boolean; cookieHygiene: 'app' | 'registrable' };
  /** AGPL §13 source offer; only ever an http(s) URL (anything else is dropped). */
  source_url: string | null;
  limits: { max_ws_per_session: number };
}

/** Documented defaults (docs/ARCHITECTURE.md §4.2) used when a server omits an optional member. */
const CONFIG_DEFAULTS = {
  wispPath: '/wisp/',
  ticketTtlS: 3_600,
  maxWsPerSession: 16,
} as const;

/** Minimal shape check: something answered JSON at /api/config, but is it GNOME's configuration? */
export function isServerConfig(v: unknown): v is ServerConfig {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<ServerConfig>;
  return (
    typeof c.version === 'string' &&
    (c.access_mode === 'open' || c.access_mode === 'code' || c.access_mode === 'accounts') &&
    !!c.features &&
    typeof c.features === 'object'
  );
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const flag = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const posInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;

function httpUrlOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function originOrNull(v: unknown): string | null {
  const href = httpUrlOrNull(v);
  return href ? new URL(href).origin : null;
}

/**
 * Normalizes a GNOME configuration: members a (possibly older) server omits get their documented defaults, values of
 * the wrong type fall back, and URLs that end up in links or frames must be http(s). Callers can rely on every field.
 */
export function normalizeServerConfig(c: ServerConfig): ServerConfig {
  const raw = c as unknown as Record<string, unknown>;
  const features = obj(raw.features);
  const wisp = obj(raw.wisp);
  const engines = obj(raw.engines);
  const proxy = obj(raw.proxy);
  const profiles = (Array.isArray(wisp.profiles) ? wisp.profiles : [])
    .map(obj)
    .filter((p) => ['id', 'label', 'country_code', 'city', 'path'].every((k) => typeof p[k] === 'string'))
    .map((p) => ({ id: p.id, label: p.label, country_code: p.country_code, city: p.city, path: p.path }) as WispProfileInfo);
  const engineDefault: EngineId = engines.default === 'ultraviolet' ? 'ultraviolet' : 'scramjet';
  return {
    version: c.version,
    access_mode: c.access_mode,
    registration: raw.registration === 'open' ? 'open' : 'closed',
    features: {
      accounts: flag(features.accounts),
      sync: flag(features.sync),
      games: flag(features.games),
      vpn_gateway: flag(features.vpn_gateway),
      thumb_proxy: flag(features.thumb_proxy),
    },
    wisp: {
      path: typeof wisp.path === 'string' && wisp.path.startsWith('/') ? wisp.path : CONFIG_DEFAULTS.wispPath,
      ticket_ttl_s: posInt(wisp.ticket_ttl_s, CONFIG_DEFAULTS.ticketTtlS),
      profiles,
      custom_servers: flag(wisp.custom_servers),
    },
    engines: { default: engineDefault, scramjet: flag(engines.scramjet, true), ultraviolet: flag(engines.ultraviolet, true) },
    proxy: {
      origin: originOrNull(proxy.origin),
      isolated: flag(proxy.isolated),
      cookieHygiene: proxy.cookieHygiene === 'registrable' ? 'registrable' : 'app',
    },
    source_url: httpUrlOrNull(raw.source_url),
    limits: { max_ws_per_session: posInt(obj(raw.limits).max_ws_per_session, CONFIG_DEFAULTS.maxWsPerSession) },
  };
}

/** GET /api/health (docs/API.md). A `degraded` server answers 503, which getHealth() rejects as an ApiError. */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime_s: number;
  db: 'ok' | 'error';
  /** Wisp upstreams by id (`direct` = the primary HolyWisp; VPN gateway profiles by their id). */
  wisp: Record<string, 'up' | 'down' | 'unknown'>;
}

/**
 * GET /api/config, normalized (normalizeServerConfig); rejects with `invalid_response` when the answer is not a
 * GNOME configuration.
 */
export async function getConfig(signal?: AbortSignal): Promise<ServerConfig> {
  const cfg = await api.get<unknown>('/api/config', { ...(signal ? { signal } : {}), timeoutMs: 8000 });
  if (!isServerConfig(cfg)) {
    throw new ApiError({ status: 200, code: 'invalid_response', message: DEFAULT_MESSAGES.invalid_response! });
  }
  return normalizeServerConfig(cfg);
}
export const getHealth = (signal?: AbortSignal): Promise<HealthResponse> =>
  api.get<HealthResponse>('/api/health', { ...(signal ? { signal } : {}), timeoutMs: 8000 });

// ── Session ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Session {
  kind: 'anonymous' | 'user';
  expiresAt: number;
}

interface SessionResponse {
  session: { kind: 'anonymous' | 'user'; expires_at: number };
}

/**
 * Asks the user for an access code. `submit` tries a code and resolves to null on success or an error message to
 * show (the prompt stays open). Resolve the outer promise with true once a submit succeeded, false if cancelled.
 */
export type AccessCodePrompt = (ctx: { submit: (code: string) => Promise<string | null> }) => Promise<boolean>;

let accessCodePrompt: AccessCodePrompt | null = null;
let currentSession: Session | null = null;
let inflight: Promise<Session> | null = null;
const REFRESH_MARGIN_MS = 5 * 60_000;

/** Registered by the app shell (dialog-based); kept pluggable so lib/ never imports UI code. */
export function setAccessCodePrompt(fn: AccessCodePrompt | null): void {
  accessCodePrompt = fn;
}

export function getSession(): Session | null {
  return currentSession;
}

async function postSession(accessCode?: string): Promise<Session> {
  const res = await api.post<SessionResponse>('/api/session', accessCode !== undefined ? { access_code: accessCode } : {});
  if (!res || typeof res.session?.expires_at !== 'number') {
    throw new ApiError({ status: 200, code: 'invalid_response', message: DEFAULT_MESSAGES.invalid_response! });
  }
  currentSession = { kind: res.session.kind, expiresAt: res.session.expires_at };
  appEvents.emit('session:changed', currentSession);
  return currentSession;
}

async function createSession(): Promise<Session> {
  try {
    return await postSession();
  } catch (err) {
    if (isApiError(err, 'access_code_required') && accessCodePrompt) {
      let session: Session | null = null;
      const ok = await accessCodePrompt({
        submit: async (code) => {
          try {
            session = await postSession(code.trim());
            return null;
          } catch (e) {
            if (isApiError(e, 'access_code_required') || isApiError(e, 'forbidden') || isApiError(e, 'unauthorized')) {
              return 'That access code is not valid.';
            }
            if (isApiError(e, 'rate_limited')) {
              return e.retryAfterS ? `Too many attempts. Try again in ${e.retryAfterS} s.` : 'Too many attempts. Try again shortly.';
            }
            return e instanceof Error ? e.message : 'Could not check the access code.';
          }
        },
      });
      if (ok && session) return session;
      throw new ApiError({ status: 401, code: 'access_code_required', message: 'An access code is required to use this server.' });
    }
    if (isApiError(err, 'login_required')) appEvents.emit('session:login-required', { message: err.message });
    throw err;
  }
}

/**
 * Makes sure a session cookie exists before using the proxy (/wisp/) or session-scoped endpoints.
 * Concurrent callers share one request; a valid session is reused until 5 minutes before it expires.
 */
export function ensureSession(opts: { force?: boolean } = {}): Promise<Session> {
  if (!opts.force && currentSession && currentSession.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return Promise.resolve(currentSession);
  }
  inflight ??= createSession().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Forget the cached session (after logout or when the server rejects the cookie). */
export function invalidateSession(): void {
  currentSession = null;
}

// ── Wisp tickets (docs/ARCHITECTURE.md §4.6) ─────────────────────────────────────────────────────────────────────

export interface WispTicket {
  /** `w1.<exp_s>.<session_ref>.<mac>` — authorizes Wisp only; hand it to the engine host, never to pages. */
  ticket: string;
  /** Unix ms on the server's clock (convert with ticketExpiresAtLocal() and `date`). */
  expiresAt: number;
  /** Absolute ws(s):// URL on the proxy origin; connect to `${wispUrl}?t=${ticket}&/` (docs/API.md "Wisp"). */
  wispUrl: string;
  /** The response's `Date` header (the server's clock), or null when it had none. */
  date: string | null;
}

interface TicketResponse {
  ticket: string;
  expires_at: number;
  wisp_url: string;
}

function isWebSocketUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'wss:' || u.protocol === 'ws:';
  } catch {
    return false;
  }
}

function toTicket(res: TicketResponse | undefined, date: string | null): WispTicket {
  if (!res || typeof res.ticket !== 'string' || !res.ticket || typeof res.expires_at !== 'number' || !isWebSocketUrl(res.wisp_url)) {
    throw new ApiError({ status: 200, code: 'invalid_response', message: DEFAULT_MESSAGES.invalid_response!, body: res });
  }
  return { ticket: res.ticket, expiresAt: res.expires_at, wispUrl: res.wisp_url, date };
}

/** The route a Wisp ticket is bound to (WAVE-C D23): the gateway accepts it only on that route's path. */
export type TicketRoute = 'default' | { profile: string };

export interface TicketRequestOptions {
  signal?: AbortSignal;
  /** The route the app chose (`chooseRoute`); default `'default'` (`/wisp/`). */
  route?: TicketRoute;
  /**
   * True (the default) when the user started this mint (a navigation from GNOME's own UI, the "Sign in" button of a
   * notice): a `code`-mode server may then ask for the access code, and `accounts` mode emits
   * `session:login-required`. False for mints an engine event started (ENGINE-PROTOCOL §1.2 rule 9): they never
   * prompt and never emit anything, and reject with the server's `access_code_required` / `login_required` error.
   */
  interactive?: boolean;
}

/**
 * POST /api/wisp/ticket for the current session. Interactive (default): when the server needs a session first
 * (`code` mode without a valid cookie) it runs ensureSession() — which may ask for the access code — and retries
 * once; in `accounts` mode a `login_required` answer emits `session:login-required` and rejects. Non-interactive:
 * no prompt and no event; the error is passed on.
 */
export async function requestWispTicket(opts: TicketRequestOptions = {}): Promise<WispTicket> {
  const interactive = opts.interactive ?? true;
  const post = async (): Promise<WispTicket> => {
    let date: string | null = null;
    const route: TicketRoute = opts.route ?? 'default';
    const res = await api.post<TicketResponse>('/api/wisp/ticket', { route }, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      timeoutMs: 10_000,
      onHeaders: (h) => {
        date = h.get('date');
      },
    });
    return toTicket(res, date);
  };
  try {
    return await post();
  } catch (err) {
    if (!interactive) throw err;
    if (isApiError(err, 'access_code_required') || isApiError(err, 'unauthorized')) {
      await ensureSession({ force: true });
      return await post();
    }
    if (isApiError(err, 'login_required')) appEvents.emit('session:login-required', { message: err.message });
    throw err;
  }
}
