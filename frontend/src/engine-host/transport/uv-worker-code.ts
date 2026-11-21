/**
 * The code the transport manager installs into bare-mux's SharedWorker with `setManualTransport()` (bare-mux 2.1.9:
 * the worker runs it as `new AsyncFunction(code)()`, takes `[TransportClass, name]` from it and constructs
 * `new TransportClass(...args)`; the third argument of `setManualTransport` transfers MessagePorts into `args`).
 *
 * One Ultraviolet transport serves every engine host of the proxy origin (ENGINE-PROTOCOL §6.6). The code keeps a
 * small state object on the worker's global (`self.__gnomeUv`) across installs:
 * - **taps**: one MessagePort per engine host (sent with every install call; the previous port of that host says
 *   `bye`). Socket events of the worker's Wisp WebSocket and init results go to every tap, so the UV watchdog of every
 *   engine host keeps working after the GNOME tab that installed the transport closed. No BroadcastChannel is used:
 *   any proxied page could join one.
 * - **key / gen / name**: what runs now (`uvTransportKey()`, an install counter, and bare-mux's transport name
 *   `gnome:<gen>:<key>`, which `getTransport()` returns to anyone who asks).
 * - the decision `uvTransportAction()` (src/shared/transport.ts), made inside the worker so that two engine hosts
 *   cannot interleave a check and an install; a `rebuild` additionally installs only when no one else rebuilt since
 *   the caller last looked (`expectedGen`), so a drop seen by several engine hosts rebuilds once.
 * - "keep" registers the caller's tap and hands bare-mux the transport that already runs (a constructor that returns
 *   the existing instance), so nothing is rebuilt and no Wisp connection leaks.
 * - every installed transport memoizes `init()` (bare-mux calls `s.ready || await s.init()` per request, and two
 *   concurrent libcurl `init()` calls hang: the second replaces libcurl's onload) and retries the "wasm not loaded yet"
 *   failure of libcurl-transport 1.5.2 in Firefox for up to 5 s (spike §7 item 3), then reports the result.
 * - **the lock**: any same-origin document can connect to this SharedWorker (Ultraviolet does not wrap SharedWorker,
 *   so an ordinary proxied page can), and bare-mux accepts `set` from every port: measured in both browsers, a UV page
 *   replaced the shared transport with a `bare-mux-remote` port of its own and received every later UV request of every
 *   GNOME tab. The first GNOME install that carries a secret (`spec.secret`: kept by the engine hosts in the proxy
 *   origin's own localStorage, which proxied pages reach only through their engine's per-site wrapper) wraps
 *   bare-mux's `onconnect`: on every port connected afterwards, a `set` is refused unless its code starts with
 *   `/*gnome-uv:<secret>*\/`. `get`, `fetch`, `websocket` and `ping` pass (UV pages and the SW use them). Ports that
 *   connected before the lock (the installing engine host's own) are not wrapped. Without a secret nothing is locked.
 *
 * Messages on a tap (worker → engine host): see `UvTapMessage`. Engine host → worker: `{t: 'bye'}`.
 */

import type { UvInstallReason } from '../../shared/transport';

export interface UvInstallSpec {
  mode: UvInstallReason;
  /** uvTransportKey() of the caller's route and transport kind. */
  key: string;
  /** TRANSPORT_MODULES.ultraviolet[kind] (an absolute same-origin path). */
  module: string;
  /** `rebuild` only: the generation the caller saw last (null: unknown, behave like uvTransportAction alone). */
  expectedGen: number | null;
  /** The engine hosts' shared secret for the lock (32 lower-case hex characters), or null (no lock). */
  secret?: string | null;
}

/** The first characters of an install code that carries `secret` (what the lock checks). */
export function uvLockMarker(secret: string): string {
  return `/*gnome-uv:${secret}*/`;
}

/** A usable lock secret (16 random bytes as hex). */
export const UV_LOCK_SECRET_RE = /^[0-9a-f]{32}$/;

export type UvTapMessage =
  /** Sent to the calling tap only, from the transport's constructor (install) or the keep path. */
  | { t: 'uv-installed'; action: 'install' | 'keep'; gen: number; key: string; ready: boolean }
  /** Every tap: the init of generation `gen` finished. */
  | { t: 'uv-init'; gen: number; ok: boolean; message: string | null }
  /** Every tap: a WebSocket the worker opened (the Wisp connection of the transport of generation `gen`). */
  | { t: 'wisp'; ev: 'connecting' | 'open' | 'close'; gen: number; key: string | null; wasOpen: boolean; code: number | null };

/** Tap messages are checked like any other input (the worker runs code any same-origin client may have replaced). */
export function parseUvTapMessage(data: unknown): UvTapMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const gen = d.gen;
  if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 0) return null;
  const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length <= 9000;
  switch (d.t) {
    case 'uv-installed':
      return (d.action === 'install' || d.action === 'keep') && keyOk(d.key) && typeof d.ready === 'boolean'
        ? { t: 'uv-installed', action: d.action, gen, key: d.key, ready: d.ready }
        : null;
    case 'uv-init':
      return typeof d.ok === 'boolean' && (d.message === null || typeof d.message === 'string')
        ? { t: 'uv-init', gen, ok: d.ok, message: d.message === null ? null : String(d.message).slice(0, 300) }
        : null;
    case 'wisp':
      return (d.ev === 'connecting' || d.ev === 'open' || d.ev === 'close') &&
        (d.key === null || keyOk(d.key)) &&
        typeof d.wasOpen === 'boolean' &&
        (d.code === null || d.code === undefined || typeof d.code === 'number')
        ? { t: 'wisp', ev: d.ev, gen, key: d.key, wasOpen: d.wasOpen, code: typeof d.code === 'number' ? d.code : null }
        : null;
    default:
      return null;
  }
}

/** The bare-mux transport name of what GNOME installed (`gnome:<gen>:<key>`), parsed; null for anything else. */
export function parseUvTransportName(name: string | null | undefined): { gen: number; key: string } | null {
  const m = /^gnome:(\d{1,9}):([\s\S]*)$/.exec(name ?? '');
  return m ? { gen: Number(m[1]), key: m[2] ?? '' } : null;
}

/** Maximum number of engine-host taps the worker keeps (the oldest is dropped beyond it). */
export const UV_MAX_TAPS = 64;

/**
 * The function body for `setManualTransport(code, [{ wisp: url }, tapPort], [tapPort])`. Inputs are embedded with
 * JSON.stringify (valid JS literals); nothing else of the caller's reaches the worker.
 */
export function uvInstallCode(spec: UvInstallSpec): string {
  const MODE = JSON.stringify(spec.mode);
  const KEY = JSON.stringify(spec.key);
  const MODULE = JSON.stringify(spec.module);
  const EXPECTED = JSON.stringify(spec.expectedGen);
  const secret = spec.secret && UV_LOCK_SECRET_RE.test(spec.secret) ? spec.secret : null;
  const SECRET = JSON.stringify(secret);
  return `${secret ? uvLockMarker(secret) : ''}
const G = self.__gnomeUv || (self.__gnomeUv = (() => {
  const g = { taps: [], current: null, key: null, name: '', gen: 0, ready: false, failed: false, locked: false };
  g.post = (msg) => { for (const p of g.taps.slice()) { try { p.postMessage(msg); } catch (e) {} } };
  g.drop = (p) => { const i = g.taps.indexOf(p); if (i >= 0) g.taps.splice(i, 1); try { p.close(); } catch (e) {} };
  g.addTap = (p) => {
    if (!p || typeof p.postMessage !== 'function' || g.taps.includes(p)) return;
    g.taps.push(p);
    while (g.taps.length > ${UV_MAX_TAPS}) g.drop(g.taps[0]);
    p.onmessage = (e) => { if (e && e.data && e.data.t === 'bye') g.drop(p); };
  };
  const Native = self.WebSocket;
  if (typeof Native === 'function') {
    const on = Native.prototype.addEventListener;
    self.WebSocket = class GnomeWispSocket extends Native {
      constructor(url, protocols) {
        const rec = { t: 'wisp', gen: g.gen, key: g.key, wasOpen: false, code: null };
        let ended = false;
        const end = (code) => { if (ended) return; ended = true; g.post({ ...rec, ev: 'close', code }); };
        // A socket the worker's policy refuses (connect-src without the custom-Wisp opt-in) is a failed open: Firefox
        // throws from the constructor, Chromium fires 'error' and no 'close'.
        try { super(url, protocols); } catch (e) { end(null); throw e; }
        g.post({ ...rec, ev: 'connecting' });
        on.call(this, 'open', () => { rec.wasOpen = true; g.post({ ...rec, ev: 'open' }); });
        on.call(this, 'error', () => { if (!rec.wasOpen) end(null); });
        on.call(this, 'close', (e) => end(e && typeof e.code === 'number' ? e.code : null));
      }
    };
  }
  return g;
})());
const SECRET = ${SECRET};
if (SECRET !== null && !G.locked && typeof self.onconnect === 'function') {
  // The lock (see uv-worker-code.ts): ports that connect from now on may set a transport only with GNOME's secret.
  G.locked = true;
  const marker = '/*gnome-uv:' + SECRET + '*/';
  const connect = self.onconnect;
  self.onconnect = function (e) {
    connect.call(this, e);
    const port = e && e.ports && e.ports[0];
    const handler = port && port.onmessage;
    if (typeof handler !== 'function') return;
    port.onmessage = function (ev) {
      const d = ev && ev.data;
      const m = d && d.message;
      if (m && m.type === 'set') {
        const f = m.client && m.client.function;
        if (typeof f !== 'string' || f.slice(0, marker.length) !== marker) {
          try { d.port.postMessage({ type: 'error', error: 'GNOME: only GNOME engine hosts can set this transport' }); } catch (x) {}
          return;
        }
      }
      return handler.call(this, ev);
    };
  };
}
const MODE = ${MODE};
const KEY = ${KEY};
const EXPECTED = ${EXPECTED};
const decide = () => {
  const installed = G.gen > 0 && !G.failed ? G.key : null;
  if (MODE === 'rebuild') {
    if (installed !== null && installed !== KEY) return 'keep';
    if (installed !== null && EXPECTED !== null && G.gen !== EXPECTED) return 'keep';
    return 'install';
  }
  return installed === KEY ? 'keep' : 'install';
};
const keep = () => [class GnomeKeptTransport {
  constructor(_opts, tap) {
    G.addTap(tap);
    if (tap) tap.postMessage({ t: 'uv-installed', action: 'keep', gen: G.gen, key: G.key, ready: G.ready });
    return G.current;
  }
}, G.name];
if (decide() === 'keep') return keep();
const { default: Base } = await import(${MODULE});
if (decide() === 'keep') return keep();
// Claimed together with the last decision, before anything can interleave: bare-mux constructs the returned class
// in the order the install calls return, so the newest claim is also the last construction.
const gen = G.gen + 1;
const name = 'gnome:' + gen + ':' + KEY;
G.gen = gen; G.key = KEY; G.name = name; G.ready = false; G.failed = false;
const errText = (e) => String((e && e.message) || e).slice(0, 300);
return [class GnomeUvTransport extends Base {
  constructor(opts, tap) {
    G.addTap(tap);
    try { super(opts); } catch (e) { if (G.gen === gen) G.failed = true; throw e; }
    if (G.gen === gen) G.current = this;
    if (tap) tap.postMessage({ t: 'uv-installed', action: 'install', gen, key: KEY, ready: false });
    this.init().then(
      () => { if (G.gen === gen) G.ready = true; G.post({ t: 'uv-init', gen, ok: true, message: null }); },
      (e) => { if (G.gen === gen) G.failed = true; G.post({ t: 'uv-init', gen, ok: false, message: errText(e) }); },
    );
  }
  init() {
    if (!this.__gnomeInit) {
      this.__gnomeInit = (async () => {
        for (let i = 0; ; i++) {
          try { return await super.init(); } catch (e) {
            if (i >= 50 || !/wasm not loaded/i.test(errText(e))) throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      })();
      this.__gnomeInit.catch(() => { this.__gnomeInit = null; });
    }
    return this.__gnomeInit;
  }
}, name];
`;
}
