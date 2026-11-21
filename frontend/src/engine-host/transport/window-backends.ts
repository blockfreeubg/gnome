/**
 * The real backends of the transport manager on the engine-host page (spike §4.5): the Scramjet-side transports in
 * this realm with a WebSocket tap, the shared Ultraviolet transport in bare-mux's SharedWorker (with the lock secret,
 * uv-worker-code.ts), and the probe. The transports themselves need a browser: the e2e suites exercise them
 * (tests/e2e/engine/suites/transport.mjs); the connect wrapper, the probe and the lock are also unit-tested
 * (window-backends.test.ts, shared-uv.test.ts).
 */

import type { TransportKind } from '../../shared/engine-protocol';
import { TRANSPORT_MODULES, VENDOR } from '../../shared/proxy-origin';
import type { ScramjetTransport } from '../../shared/transport';
import type { ProbeResponse, RawResponse, ScramjetBackend, UvBackend, UvInstallResult, UvSocketEvent, WindowSocketEvent } from './backends';
import { UV_LOCK_SECRET_RE, parseUvTapMessage, uvInstallCode, type UvTapMessage } from './uv-worker-code';

/**
 * localStorage key of the engine hosts' shared lock secret for the bare-mux worker (uv-worker-code.ts "the lock").
 * Every engine host of the proxy origin reads the same value; proxied pages see the origin's storage only through
 * their engine's per-site wrapper. The `gnome-` prefix keeps it out of "clear site data" (lane a's site-data.ts).
 */
export const UV_LOCK_STORAGE_KEY = 'gnome-uv-transport-lock';

/** The shared lock secret (created on first use), or null when this page has no usable localStorage. */
export function uvLockSecret(win: Pick<Window, 'localStorage' | 'crypto'>): string | null {
  try {
    const storage = win.localStorage;
    const have = storage.getItem(UV_LOCK_STORAGE_KEY);
    if (have && UV_LOCK_SECRET_RE.test(have)) return have;
    const bytes = win.crypto.getRandomValues(new Uint8Array(16));
    storage.setItem(UV_LOCK_STORAGE_KEY, Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    // Two engine hosts starting at once: whichever value stayed is the one every later install reads.
    const kept = storage.getItem(UV_LOCK_STORAGE_KEY);
    return kept && UV_LOCK_SECRET_RE.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** proxy-transports 1.0.2 ProxyTransport, as far as the manager touches it. */
interface ProxyTransportLike {
  init(): Promise<void>;
  request(remote: URL, method: string, body: BodyInit | null, headers: Array<[string, string]>, signal: AbortSignal | undefined): Promise<{
    body: unknown;
    headers: Array<[string, string]>;
    status: number;
  }>;
  connect(
    url: URL,
    protocols: string[],
    requestHeaders: Array<[string, string]>,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (data: unknown) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void,
  ): [(data: unknown) => void, (code: number, reason: string) => void];
}

type TransportCtor = new (opts: { wisp: string }) => ProxyTransportLike;

const importModule = (path: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>;

let windowTap: { listeners: Set<(e: WindowSocketEvent) => void>; Native: typeof WebSocket } | null = null;

/**
 * Wraps this realm's WebSocket once (before any transport module loads), so the watchdog sees every connect, open
 * and close of the Scramjet-side transports' Wisp sockets. The manager matches the URL against its endpoint.
 */
function installWindowTap(win: Window & typeof globalThis): Set<(e: WindowSocketEvent) => void> {
  if (windowTap) return windowTap.listeners;
  const listeners = new Set<(e: WindowSocketEvent) => void>();
  const Native = win.WebSocket;
  windowTap = { listeners, Native };
  const on = win.EventTarget.prototype.addEventListener;
  const emit = (e: WindowSocketEvent): void => {
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        /* a listener's problem must not break the socket */
      }
    }
  };
  class GnomeWispSocket extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      const rec = { url: String(url), wasOpen: false };
      let ended = false;
      const end = (code: number | null): void => {
        if (ended) return;
        ended = true;
        emit({ ...rec, ev: 'close', code });
      };
      // A socket this realm's policy refuses (connect-src without the custom-Wisp opt-in) is a failed open: Firefox
      // throws from the constructor (NS_ERROR_CONTENT_BLOCKED), Chromium fires 'error' and no 'close'.
      try {
        super(url, protocols);
      } catch (err) {
        end(null);
        throw err;
      }
      emit({ ...rec, ev: 'connecting', code: null });
      on.call(this, 'open', () => {
        rec.wasOpen = true;
        emit({ ...rec, ev: 'open', code: null });
      });
      on.call(this, 'error', () => {
        if (!rec.wasOpen) end(null);
      });
      on.call(this, 'close', (ev: Event) => end((ev as CloseEvent).code ?? null));
    }
  }
  Object.defineProperty(win, 'WebSocket', { value: GnomeWispSocket, writable: true, configurable: true, enumerable: false });
  return listeners;
}

/**
 * A test socket to a custom Wisp server (worklist A3) with this realm's NATIVE WebSocket, which the tap does not see
 * (its open and close would otherwise reach the watchdog as a transport's): true once it opens (it is closed at
 * once), false when the constructor throws (the realm's policy refuses it), it errors, or it closes first.
 */
export function windowTestSocket(win: Window & typeof globalThis): (url: string, timeoutMs?: number) => Promise<boolean> {
  return (url, timeoutMs) =>
    new Promise<boolean>((resolve) => {
      const Native = windowTap?.Native ?? win.WebSocket;
      let ws: WebSocket;
      try {
        ws = new Native(url);
      } catch {
        resolve(false);
        return;
      }
      let timer: number | undefined;
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) win.clearTimeout(timer);
        resolve(ok);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
      ws.addEventListener('open', () => done(true), { once: true });
      ws.addEventListener('error', () => done(false), { once: true });
      ws.addEventListener('close', () => done(false), { once: true });
      // A server that never answers (a blackhole) must not leave a connecting socket behind until the browser's own
      // TCP timeout: each rebuild could add one (quality review, integration part 2).
      if (timeoutMs !== undefined) timer = win.setTimeout(() => done(false), timeoutMs);
    });
}

export function windowScramjetBackend(win: Window & typeof globalThis): ScramjetBackend {
  const listeners = installWindowTap(win);
  return {
    async build(kind: TransportKind, url: string): Promise<ScramjetTransport> {
      const mod = await importModule(TRANSPORT_MODULES.scramjet[kind]);
      const Ctor = (mod.default ?? mod.LibcurlClient ?? mod.EpoxyTransport) as TransportCtor | undefined;
      if (typeof Ctor !== 'function') throw new Error(`transport module ${TRANSPORT_MODULES.scramjet[kind]} has no transport class`);
      const t = new Ctor({ wisp: url });
      await t.init();
      return t;
    },
    onSocket(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(transport, url, headers, signal): Promise<RawResponse> {
      const res = await (transport as ProxyTransportLike).request(url, 'GET', null, headers, signal);
      return { status: res.status, headers: Array.isArray(res.headers) ? res.headers : [], body: res.body };
    },
    wrapConnect(transport, check) {
      const t = transport as ProxyTransportLike & { __gnomeWrapped?: boolean };
      if (t.__gnomeWrapped) return;
      const connect = t.connect.bind(t);
      t.connect = (url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) => {
        if (check(String(url)) === 'block') {
          win.setTimeout(() => {
            onerror('blocked');
            onclose(1006, 'blocked');
          }, 0);
          return [() => {}, () => {}];
        }
        return connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
      };
      Object.defineProperty(t, '__gnomeWrapped', { value: true });
    },
  };
}

interface BareMuxGlobal {
  BareMuxConnection: new (workerPath: string) => {
    setManualTransport(code: string, args: unknown[], transfer?: Transferable[]): Promise<void>;
    getTransport(): Promise<string>;
  };
  BareClient: new () => {
    fetch(url: string | URL, init?: RequestInit): Promise<Response>;
  };
}

/** The shared Ultraviolet transport (uv-worker-code.ts) through bare-mux 2.1.9, which index.html loads as a script. */
export function bareMuxUvBackend(win: Window & typeof globalThis): UvBackend {
  const BareMux = (win as unknown as { BareMux?: BareMuxGlobal }).BareMux;
  if (!BareMux?.BareMuxConnection || !BareMux.BareClient) throw new Error('bare-mux did not load');
  const conn = new BareMux.BareMuxConnection(VENDOR.bareMuxWorker);
  const listeners = new Set<(e: UvSocketEvent) => void>();
  /** Results of inits seen on the current tap, by generation (inits can finish before anyone asks). */
  const inits = new Map<number, { ok: boolean; message: string | null }>();
  const initWaiters = new Map<number, Array<(r: { ok: boolean; message: string | null }) => void>>();
  let tap: MessagePort | null = null;

  const onTap = (msg: UvTapMessage, installed: ((m: Extract<UvTapMessage, { t: 'uv-installed' }>) => void) | null): void => {
    if (msg.t === 'uv-installed') {
      installed?.(msg);
      return;
    }
    if (msg.t === 'uv-init') {
      const r = { ok: msg.ok, message: msg.message };
      inits.set(msg.gen, r);
      if (inits.size > 32) inits.delete(inits.keys().next().value as number);
      for (const w of initWaiters.get(msg.gen) ?? []) w(r);
      initWaiters.delete(msg.gen);
      return;
    }
    for (const l of listeners) {
      try {
        l({ ev: msg.ev, gen: msg.gen, key: msg.key, wasOpen: msg.wasOpen, code: msg.code });
      } catch {
        /* ignore */
      }
    }
  };

  const waitInit = (gen: number): Promise<{ ok: boolean; message: string | null }> => {
    const known = inits.get(gen);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const list = initWaiters.get(gen) ?? [];
      list.push(resolve);
      initWaiters.set(gen, list);
    });
  };

  win.addEventListener('pagehide', () => {
    try {
      tap?.postMessage({ t: 'bye' });
    } catch {
      /* closed */
    }
  });

  return {
    async install(mode, key, kind, url, expectedGen): Promise<UvInstallResult> {
      const channel = new win.MessageChannel();
      const previous = tap;
      tap = channel.port1;
      if (previous) {
        try {
          previous.postMessage({ t: 'bye' });
        } catch {
          /* closed */
        }
        previous.close();
      }
      let resolveInstalled!: (m: Extract<UvTapMessage, { t: 'uv-installed' }>) => void;
      const installed = new Promise<Extract<UvTapMessage, { t: 'uv-installed' }>>((r) => (resolveInstalled = r));
      let pending: typeof resolveInstalled | null = resolveInstalled;
      channel.port1.onmessage = (e: MessageEvent) => {
        const msg = parseUvTapMessage(e.data);
        if (!msg) return;
        const cb = pending;
        if (msg.t === 'uv-installed') pending = null;
        onTap(msg, cb);
      };
      // Read on every install: an engine host that lost a first-use race picks up the stored value on its retry.
      const code = uvInstallCode({ mode, key, module: TRANSPORT_MODULES.ultraviolet[kind], expectedGen, secret: uvLockSecret(win) });
      await conn.setManualTransport(code, [{ wisp: url }, channel.port2], [channel.port2]);
      const res = await installed;
      if (!res.ready) {
        const init = await waitInit(res.gen);
        if (!init.ok) throw new Error(`Ultraviolet transport init failed: ${init.message ?? 'unknown error'}`);
      }
      return { action: res.action, gen: res.gen, key: res.key };
    },
    onSocket(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(url, headers, signal): Promise<RawResponse> {
      const client = new BareMux.BareClient();
      const res = await client.fetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
      const out: Array<[string, string]> = [];
      res.headers.forEach((v, k) => out.push([k, v]));
      return { status: res.status, headers: out, body: res.body };
    },
  };
}

/** The ticket probe: a plain same-origin GET (no Upgrade, no cookies), body read for `error.code` (≤ 4 KiB). */
export function windowProbe(win: Window & typeof globalThis): (url: string) => Promise<ProbeResponse | null> {
  const fetch = win.fetch.bind(win);
  return async (url: string) => {
    let res: Response;
    try {
      res = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'manual' });
    } catch {
      return null;
    }
    let errorCode: string | null = null;
    try {
      const text = (await res.text()).slice(0, 4096);
      const parsed = JSON.parse(text) as { error?: { code?: unknown } } | null;
      if (typeof parsed?.error?.code === 'string') errorCode = parsed.error.code.slice(0, 64);
    } catch {
      errorCode = null;
    }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), errorCode };
  };
}
