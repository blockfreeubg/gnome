/**
 * Who is signed in (docs/API.md "Accounts"): the reactive `account` state used by the rail and Settings → Account &
 * sync, plus sign-in, registration, sign-out, password change and account deletion.
 *
 * Signed-out visitors cost no request. The session cookie is HttpOnly, so this browser remembers whether it was
 * signed in (`gnome:account:v1` in localStorage: the user's id and name, nothing secret) and asks the server
 * (`GET /api/session`) only then. The name is shown in the rail right away and replaced once the server answers. Tabs
 * follow each other's sign-in and sign-out through that key (they share the cookie).
 *
 * `initAccount()` runs at startup (main.ts). Sync itself lives in account-sync.ts, loaded once the page is idle; the
 * form checks and error wording in account-forms.ts.
 */
import { untrack } from 'svelte';
import { server } from '../app/server.svelte';
import { api, ensureSession, invalidateSession, isApiError } from '../lib/api';
import { appEvents } from '../lib/events';
import { kvDelete } from '../lib/idb';
import type { RecordKind, SyncStatus } from './sync';

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: number;
}

function isUser(v: unknown): v is User {
  if (!v || typeof v !== 'object') return false;
  const u = v as Partial<User>;
  return typeof u.id === 'number' && typeof u.username === 'string' && typeof u.is_admin === 'boolean' && typeof u.created_at === 'number';
}

// ── Sign-in hint (localStorage) ──────────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_HINT_KEY = 'gnome:account:v1';

interface Hint {
  id: number;
  username: string;
}

function readHint(): Hint | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ACCOUNT_HINT_KEY) : null;
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Hint> | null;
    if (!v || typeof v.id !== 'number' || typeof v.username !== 'string' || !v.username || v.username.length > 64) return null;
    return { id: v.id, username: v.username };
  } catch {
    return null;
  }
}

function writeHint(user: User | null): void {
  try {
    if (user) localStorage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ id: user.id, username: user.username }));
    else localStorage.removeItem(ACCOUNT_HINT_KEY);
  } catch {
    /* storage disabled: the server is asked again on every load */
  }
}

// ── Sync bookkeeping kept per user (IndexedDB kv; used by account-sync.ts, removed on sign-out) ──────────────────

export const SYNC_BASE_KEY = 'sync:settings:base';
export const syncCursorKey = (kind: RecordKind, userId: number): string => `sync:${kind}:since:${userId}`;

async function forgetSyncState(userId: number | null): Promise<void> {
  try {
    await kvDelete(SYNC_BASE_KEY);
    if (userId !== null) {
      await kvDelete(syncCursorKey('bookmarks', userId));
      await kvDelete(syncCursorKey('history', userId));
    }
  } catch {
    /* storage unavailable: nothing persisted */
  }
}

// ── Reactive account state ───────────────────────────────────────────────────────────────────────────────────────

const userListeners = new Set<(user: User | null, prev: User | null) => void>();

/** Called when the signed-in user changes (sign-in, sign-out, session ended). Returns an unsubscribe function. */
export function onUserChange(fn: (user: User | null, prev: User | null) => void): () => void {
  userListeners.add(fn);
  return () => userListeners.delete(fn);
}

class AccountState {
  /** The signed-in user as the server confirmed it, or null. */
  user = $state.raw<User | null>(null);
  /** True once it is known whether someone is signed in (the server answered, or there was nothing to ask). */
  checked = $state(false);
  /** Why the last check failed (server unreachable or erroring); the check is repeated on the next request for it. */
  error = $state<string | null>(null);
  /** Sync status, kept up to date by account-sync.ts. */
  sync = $state.raw<SyncStatus>({ state: 'signed-out', lastSyncedAt: null, error: null });
  /** The name this browser was last signed in with (shown until the server has confirmed it). */
  #hint = $state.raw<Hint | null>(readHint());

  get signedIn(): boolean {
    return this.user !== null;
  }

  /** Name for the rail: the signed-in user, or while the check is pending or failed, the last known one. */
  get displayName(): string | null {
    if (this.user) return this.user.username;
    return this.checked && !this.error ? null : (this.#hint?.username ?? null);
  }

  /** Whether the server offers accounts at all (null while /api/config is unknown). */
  get available(): boolean | null {
    const cfg = server.config;
    return cfg ? cfg.features.accounts : null;
  }

  get registrationOpen(): boolean {
    return server.config?.registration === 'open';
  }

  get syncAvailable(): boolean {
    return !!server.config?.features.accounts && !!server.config?.features.sync;
  }

  #inflight: Promise<User | null> | null = null;

  /**
   * Asks the server who is signed in (GET /api/session; concurrent callers share one request). Network or server
   * trouble keeps what was known and rejects; `error` says why.
   */
  refresh(): Promise<User | null> {
    this.#inflight ??= this.#fetchSession().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #fetchSession(): Promise<User | null> {
    try {
      // 200 for any session (`kind: "user"` when signed in, `"anonymous"` otherwise); 401 when there is none.
      const res = await api.get<{ session?: { kind?: unknown; user?: unknown } }>('/api/session', { timeoutMs: 8000 });
      const s = res?.session;
      this.#setUser(s?.kind === 'user' && isUser(s.user) ? s.user : null);
    } catch (err) {
      if (!isApiError(err, 'unauthorized') && !isApiError(err, 'login_required') && !isApiError(err, 'not_found')) {
        this.error =
          isApiError(err) && !err.fromGnome && (err.code === 'network_error' || err.code === 'timeout' || err.status >= 502)
            ? 'The GNOME server is not reachable.'
            : 'The GNOME server could not check your session.';
        this.checked = true;
        throw err;
      }
      this.#setUser(null);
    }
    this.error = null;
    this.checked = true;
    return this.user;
  }

  async register(username: string, password: string): Promise<User> {
    const post = (): Promise<{ user: User }> => api.post<{ user: User }>('/api/auth/register', { username, password });
    let res: { user: User };
    try {
      res = await post();
    } catch (err) {
      // `code` mode: an account can be created only after entering the access code (anonymous session first).
      if (!isApiError(err, 'access_code_required')) throw err;
      await ensureSession({ force: true });
      res = await post();
    }
    this.#signedIn(res.user);
    return res.user;
  }

  async login(username: string, password: string): Promise<User> {
    const res = await api.post<{ user: User }>('/api/auth/login', { username, password });
    this.#signedIn(res.user);
    return res.user;
  }

  /**
   * Signs out. Only when the server has answered: its cookie is HttpOnly, so if the request fails the session stays
   * valid and this browser must not merely look signed out (it rejects; nothing changes).
   */
  async logout(): Promise<void> {
    const id = this.user?.id ?? null;
    try {
      await api.post('/api/auth/logout');
    } catch (err) {
      // The server says there is no session anyway: the end state is the same.
      if (!isApiError(err, 'unauthorized') && !isApiError(err, 'login_required')) throw err;
    }
    await forgetSyncState(id);
    invalidateSession();
    this.#setUser(null);
  }

  /** Changes the password; the server signs out every other session of this account. */
  async changePassword(current: string, next: string): Promise<void> {
    await api.post('/api/auth/password', { current, next });
  }

  /** Deletes the account and everything synced to it. Local data in this browser stays. */
  async deleteAccount(password: string): Promise<void> {
    const id = this.user?.id ?? null;
    await api.delete('/api/auth/account', { password });
    await forgetSyncState(id);
    invalidateSession();
    this.#setUser(null);
  }

  /** Another tab signed out (the cookie both share is gone): follow without asking the server. */
  followSignOut(): void {
    this.#hint = null;
    this.error = null;
    this.checked = true;
    this.#setUser(null, false);
  }

  #signedIn(user: User): void {
    invalidateSession();
    this.error = null;
    this.#setUser(user);
    this.checked = true;
  }

  #setUser(user: User | null, persist = true): void {
    const prev = this.user;
    if (persist) writeHint(user);
    this.#hint = user ? { id: user.id, username: user.username } : null;
    if (prev?.id === user?.id && prev?.username === user?.username) {
      if (user) this.user = user;
      return;
    }
    this.user = user;
    userListeners.forEach((fn) => fn(user, prev));
  }
}

export const account = new AccountState();

let initialized = false;

/**
 * Starts following the sign-in state (idempotent; main.ts at startup): once /api/config says the server has
 * accounts, asks who is signed in if this browser was signed in last time; follows other tabs; re-checks when an
 * `accounts`-mode session turns out to belong to a user.
 */
export function initAccount(): () => void {
  if (initialized || typeof window === 'undefined') return () => {};
  initialized = true;

  const stopConfig = $effect.root(() => {
    $effect(() => {
      const cfg = server.config;
      if (!cfg) return;
      untrack(() => {
        if (account.checked && !account.error) return;
        if (!cfg.features.accounts) {
          account.checked = true;
          return;
        }
        if (readHint() || account.error) void account.refresh().catch(() => {});
        else account.checked = true; // never signed in here, or signed out: nothing to ask
      });
    });
  });

  const onStorage = (ev: StorageEvent): void => {
    if (ev.key !== ACCOUNT_HINT_KEY && ev.key !== null) return; // null: the whole storage was cleared
    if (!server.config?.features.accounts) return;
    const hint = readHint();
    if (!hint) {
      if (account.user) account.followSignOut();
    } else if (hint.id !== account.user?.id) {
      void account.refresh().catch(() => {});
    }
  };
  window.addEventListener('storage', onStorage);

  const offSession = appEvents.on('session:changed', ({ kind }) => {
    if (kind === 'user' && !account.user && account.available) void account.refresh().catch(() => {});
  });

  return () => {
    stopConfig();
    window.removeEventListener('storage', onStorage);
    offSession();
    initialized = false;
  };
}
