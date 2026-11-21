/**
 * Runtime server configuration (GET /api/config). Loaded once at startup without blocking the UI. When the server
 * cannot be used, the app keeps working locally: the "server" status explains why and nothing is logged or toasted
 * (features that need the server report their own errors when the user asks for them).
 *
 * Failed loads are retried a few times with backoff (a server that is restarting comes back without a reload), and
 * again whenever the tab becomes visible or the network returns — never in a tight loop.
 */
import { getConfig, isApiError, type ServerConfig } from '../lib/api';
import { reportStatus } from './status';

/** Delays before automatic retries after a failed load; afterwards only visibility/online changes retry. */
export const RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 300_000];
/** Minimum spacing between retries triggered by visibility/online events. */
const EVENT_RETRY_MIN_MS = 30_000;

export type ServerProblem = 'unreachable' | 'not-gnome' | 'server-error';

/** Turns a failed GET /api/config into a short, honest status line (pure; unit-tested). */
export function describeServerFailure(err: unknown): { problem: ServerProblem; detail: string } {
  // GNOME's own error envelope first: the server is up (even its 503 `timeout` means it answered).
  if (isApiError(err) && err.fromGnome) {
    return { problem: 'server-error', detail: `The GNOME server answered with an error: ${err.message}` };
  }
  if (isApiError(err, 'network_error') || isApiError(err, 'timeout')) {
    return { problem: 'unreachable', detail: 'The GNOME server is not reachable. Local features keep working.' };
  }
  if (isApiError(err) && err.status >= 502 && err.status <= 504) {
    // A reverse proxy (or the dev server) is up but the GNOME backend behind it is not.
    return { problem: 'unreachable', detail: 'The GNOME server is not reachable. Local features keep working.' };
  }
  const status = isApiError(err) && err.status > 0 ? ` (HTTP ${err.status})` : '';
  return {
    problem: 'not-gnome',
    detail: `No GNOME server answered at this address${status}. Local features keep working.`,
  };
}

class ServerState {
  config = $state.raw<ServerConfig | null>(null);
  /** null = not checked yet. */
  reachable = $state<boolean | null>(null);
  error = $state<string | null>(null);
  problem = $state<ServerProblem | null>(null);
  lastCheckedAt = $state<number | null>(null);

  #inflight: Promise<void> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #listening = false;

  /** Loads (or reloads) the configuration; concurrent callers share one request. */
  refresh(): Promise<void> {
    this.#clearRetry();
    this.#inflight ??= this.#load().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #load(): Promise<void> {
    this.#listen();
    if (this.reachable === null) reportStatus('server', { state: 'starting', detail: 'Contacting the GNOME server…' });
    try {
      const cfg = await getConfig();
      this.config = cfg;
      this.reachable = true;
      this.error = null;
      this.problem = null;
      this.#failures = 0;
      reportStatus('server', {
        state: 'ok',
        detail: `GNOME server ${cfg.version} · ${cfg.access_mode} access`,
        data: { access_mode: cfg.access_mode, features: cfg.features, proxy_isolated: cfg.proxy?.isolated ?? null },
      });
    } catch (err) {
      const { problem, detail } = describeServerFailure(err);
      this.reachable = false;
      this.error = detail;
      this.problem = problem;
      reportStatus('server', { state: 'down', detail });
      this.#scheduleRetry();
    } finally {
      this.lastCheckedAt = Date.now();
    }
  }

  #scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.#failures];
    this.#failures++;
    if (delay === undefined || typeof window === 'undefined') return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void this.refresh();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  /** Retry after the network comes back or the tab is shown again (only while the server is unusable). */
  #listen(): void {
    if (this.#listening || typeof window === 'undefined') return;
    this.#listening = true;
    const retry = (): void => {
      if (this.reachable !== false || this.#inflight) return;
      if (this.lastCheckedAt !== null && Date.now() - this.lastCheckedAt < EVENT_RETRY_MIN_MS) return;
      void this.refresh();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') retry();
    });
  }
}

export const server = new ServerState();
