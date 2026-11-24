/**
 * The e2e driver page (`<app origin>/e2e-driver/`, written into the e2e build by tests/e2e/engine/lib/build.mjs):
 * a minimal app-side engine client that embeds the REAL built engine host (`<proxy origin>/engine/`) exactly as the
 * app does (ENGINE-PROTOCOL §2.1 sandbox and allow), runs the hardened handshake with the contract's own helpers
 * (decideHello, validateResultMessage, validateCommandResult, validateEventMessage), mints real Wisp tickets from
 * gnome-server (`POST /api/wisp/ticket`, `ticketExpiresAtLocal` with the Date header, at most 1 per 2 s and 10 per
 * minute, deferred and coalesced) and exposes `window.gnomeTest` to the suites (lib/drive.mjs).
 *
 * Query: engine=auto|scramjet|ultraviolet, transport=libcurl|epoxy, route=default|profile:<id>,
 * fallback=0|1, webrtc=block|allow, ticket=0 (start without one), autoTicket=0 (the suite answers needTicket),
 * engines=scramjet,ultraviolet (offered engines), combos=Mod+K,Alt+ArrowLeft; Wave B step 3 (WAVE-B3 §12.1):
 * blockerKey=<64 lower-case hex digits> (`init.blockerKey`: the content blocker caches its MAC'd engines; absent = no
 * cache, D6), clearSiteData=1 / clearCookies=1 (`init.clearOnStart.siteData` / `.cookies`).
 * It is test infrastructure, not GNOME's browser (lane c builds that): no UI beyond a status line.
 */
import {
  ENGINE_IDS,
  PROTOCOL_VERSION,
  TICKET,
  commandTimeoutMs,
  decideHello,
  ticketExpiresAtLocal,
  validateCommandResult,
  validateEngineSettings,
  validateEventMessage,
  validateResultMessage,
  type CommandType,
  type EngineId,
  type EngineSettings,
  type Ticket,
  type TransportKind,
  type WispRoute,
} from '../../../../../frontend/src/shared/engine-protocol';
import { engineHostUrl } from '../../../../../frontend/src/shared/proxy-origin';

type Evt = { seq: number; t: number; type: string; p: Record<string, unknown> };

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status') as HTMLElement;
const say = (s: string): void => {
  statusEl.textContent = s;
};

const T = {
  events: [] as Evt[],
  rejected: [] as Array<{ t: number; kind: string; error: string }>,
  results: { invalid: 0 },
  hellos: { connect: 0, unexpected: 0, mismatch: 0, ignored: 0 },
  init: null as unknown,
  initError: null as string | null,
  instance: null as string | null,
  ticketRequests: 0,
  ticketErrors: [] as string[],
  tickets: [] as Array<{ at: number; expiresAt: number }>,
  settings: null as EngineSettings | null,
  config: null as Record<string, unknown> | null,
  cmd: (type: string, p: unknown, timeout?: number): Promise<unknown> => cmd(type as CommandType, p, timeout),
  /** Mint a ticket now and send it (bypasses the rate limiter; suites use it sparingly). */
  renewNow: async (): Promise<unknown> => cmd('ticket', await mint(), 30_000),
  /** Send an arbitrary ticket value (e.g. a forged one) with a 1 h expiry. */
  sendTicket: (value: string): Promise<unknown> =>
    cmd('ticket', { value, expiresAt: Date.now() + 3_600_000, wispUrl: `${PROXY.replace(/^http/, 'ws')}/wisp/` }, 30_000),
  /** A full settings snapshot with the given changes (the `settings` command). */
  applySettings: (patch: Partial<EngineSettings>): Promise<unknown> => {
    if (!T.settings) return Promise.reject(new Error('not initialized'));
    T.settings = { ...T.settings, ...patch } as EngineSettings;
    return cmd('settings', { settings: T.settings });
  },
  /** Replace the engine iframe element (what the app does to reconnect: ENGINE-PROTOCOL §2.3). */
  replaceIframe: (): void => embed(),
  iframe: null as HTMLIFrameElement | null,
};
(window as unknown as { gnomeTest: typeof T }).gnomeTest = T;

const config = (await (await fetch('/api/config', { headers: { 'X-GNOME-Request': '1' } })).json()) as {
  proxy: { origin: string };
  engines?: { scramjet?: boolean; ultraviolet?: boolean };
};
T.config = config as unknown as Record<string, unknown>;
const PROXY = new URL(config.proxy.origin).origin;

function routeFromQuery(): WispRoute {
  const r = params.get('route') ?? 'default';
  if (r.startsWith('profile:')) return { kind: 'profile', id: r.slice('profile:'.length) };
  if (r.startsWith('custom:')) return { kind: 'custom', servers: r.slice('custom:'.length).split(',') };
  return { kind: 'default' };
}

function settingsFromQuery(): EngineSettings {
  const offered = (params.get('engines') ?? 'scramjet,ultraviolet').split(',');
  const engines = Object.fromEntries(ENGINE_IDS.map((e) => [e, offered.includes(e) && config.engines?.[e] !== false])) as Record<EngineId, boolean>;
  const engine = (params.get('engine') ?? 'auto') as EngineSettings['engine'];
  const s: EngineSettings = {
    engines,
    engine,
    autoFallback: params.get('fallback') !== '0',
    transport: (params.get('transport') ?? 'libcurl') as TransportKind,
    route: routeFromQuery(),
    privacy: {
      webrtc: params.get('webrtc') === 'allow' ? 'allow' : 'block',
      sendGpc: false,
      doNotTrack: false,
      referrer: 'default',
      stripTrackingParams: false,
      cookies: 'all',
    },
    extensions: {
      enabled: { adblock: false, trackers: false, privacy: false, cookies: false, cosmetic: false },
      lists: [],
      allowlist: [],
      perSite: {},
      cosmeticAggressive: false,
      cookieRules: {},
    },
    keys: { combos: (params.get('combos') ?? 'Mod+K,Alt+ArrowLeft,F6').split(',').filter(Boolean), apple: false },
  };
  const v = validateEngineSettings(s);
  if (!v.ok) throw new Error(`driver settings invalid: ${v.error}`);
  return v.value;
}

// ── Tickets ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function mint(): Promise<Ticket> {
  T.ticketRequests += 1;
  // Route-bound tickets (WAVE-C D23): a profile route mints for that profile; every other route mints the default.
  const route = routeFromQuery();
  const r = await fetch('/api/wisp/ticket', {
    method: 'POST',
    headers: { 'X-GNOME-Request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ route: route.kind === 'profile' ? { profile: route.id } : 'default' }),
  });
  if (!r.ok) throw new Error(`ticket: HTTP ${r.status}`);
  const j = (await r.json()) as { ticket: string; expires_at: number; wisp_url: string };
  const ttl = Number((T.config?.wisp as { ticket_ttl_s?: number } | undefined)?.ticket_ttl_s ?? 3600) * 1000;
  // expires_at is Unix ms on the server's clock (API.md); converted to this browser's clock with the Date header.
  const expiresAt = ticketExpiresAtLocal(j.expires_at, r.headers.get('date'), Date.now(), ttl);
  T.tickets.push({ at: Date.now(), expiresAt });
  return { value: j.ticket, expiresAt, wispUrl: j.wisp_url };
}

const mintTimes: number[] = [];
let mintTimer: number | null = null;
let mintRunning = false;
/** needTicket: deferred and coalesced inside the app's limits, never dropped (ENGINE-PROTOCOL §6.5). */
function requestTicket(): void {
  if (params.get('autoTicket') === '0') return;
  if (mintTimer !== null || mintRunning) {
    pendingAgain = mintRunning;
    return;
  }
  const now = Date.now();
  while (mintTimes.length && now - (mintTimes[0] ?? now) >= 60_000) mintTimes.shift();
  const last = mintTimes.at(-1) ?? -Infinity;
  let wait = Math.max(0, last + TICKET.appMinIntervalMs - now);
  if (mintTimes.length >= TICKET.appMaxPerMinute) wait = Math.max(wait, (mintTimes[0] ?? now) + 60_000 - now);
  mintTimer = window.setTimeout(async () => {
    mintTimer = null;
    mintRunning = true;
    mintTimes.push(Date.now());
    try {
      await cmd('ticket', await mint(), 30_000);
    } catch (err) {
      T.ticketErrors.push(String((err as Error).message ?? err));
    } finally {
      mintRunning = false;
      if (pendingAgain) {
        pendingAgain = false;
        requestTicket();
      }
    }
  }, wait);
}
let pendingAgain = false;

// ── Handshake ────────────────────────────────────────────────────────────────────────────────────────────────────

let port: MessagePort | null = null;
let expecting = false;
let nextId = 1;
const pending = new Map<number, { type: CommandType; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: number }>();
let seq = 0;

function embed(): void {
  T.iframe?.remove();
  port?.close();
  port = null;
  for (const [, w] of pending) {
    clearTimeout(w.timer);
    w.reject(new Error('engine host restarted'));
  }
  pending.clear();
  const f = document.createElement('iframe');
  f.id = 'engine';
  f.title = 'Browser content';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation');
  f.setAttribute('allow', 'fullscreen; clipboard-write; autoplay');
  T.iframe = f;
  expecting = true;
  f.src = engineHostUrl(PROXY);
  document.body.append(f);
}

window.addEventListener('message', (e) => {
  if (!T.iframe) return;
  const d = decideHello({ source: e.source, origin: e.origin, data: e.data }, { expectedSource: T.iframe.contentWindow, proxyOrigin: PROXY, expecting, connectedInstance: T.instance });
  if (d.action === 'ignore') {
    if (d.reason !== 'duplicate' && e.source === T.iframe.contentWindow) T.hellos.ignored += 1;
    return;
  }
  if (d.action === 'unexpected') {
    T.hellos.unexpected += 1;
    return;
  }
  if (d.action === 'mismatch') {
    T.hellos.mismatch += 1;
    say('GNOME was updated — reload');
    return;
  }
  T.hellos.connect += 1;
  expecting = false;
  T.instance = d.hello.instance;
  const ch = new MessageChannel();
  port = ch.port1;
  port.onmessage = onMessage;
  T.iframe.contentWindow?.postMessage({ gnome: 'connect', protocol: PROTOCOL_VERSION, instance: d.hello.instance }, PROXY, [ch.port2]);
  void init();
});

async function init(): Promise<void> {
  try {
    T.settings = settingsFromQuery();
    let ticket: Ticket | null = null;
    if (params.get('ticket') !== '0') {
      ticket = await mint();
      mintTimes.push(Date.now());
    }
    const blockerKey = params.get('blockerKey');
    if (blockerKey !== null && !/^[0-9a-f]{64}$/.test(blockerKey)) throw new Error('blockerKey must be 64 lower-case hex digits');
    const clearOnStart = { cookies: params.get('clearCookies') === '1', siteData: params.get('clearSiteData') === '1' };
    const res = await cmd('init', { settings: T.settings, ticket, clearOnStart, ...(blockerKey !== null ? { blockerKey } : {}) });
    T.init = res;
    T.initError = null;
    const st = (res as { status: { engines: Record<EngineId, { state: string }> } }).status;
    say(`scramjet: ${st.engines.scramjet.state}, ultraviolet: ${st.engines.ultraviolet.state}`);
  } catch (err) {
    T.initError = String((err as Error).message ?? err);
    say(`init failed: ${T.initError}`);
  }
}

function cmd(type: CommandType, p: unknown, timeout?: number): Promise<unknown> {
  if (!port) return Promise.reject(new Error('engine host not connected'));
  const id = nextId++;
  const ms = timeout ?? commandTimeoutMs(type);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${type}: timeout after ${ms} ms`));
    }, ms);
    pending.set(id, { type, resolve, reject, timer });
    port?.postMessage({ k: 'cmd', id, type, p });
  });
}

function onMessage(e: MessageEvent): void {
  const data = e.data as { k?: unknown } | null;
  if (data && data.k === 'res') {
    const r = validateResultMessage(data);
    if (!r.ok) {
      T.results.invalid += 1;
      T.rejected.push({ t: Date.now(), kind: 'result', error: r.error });
      return;
    }
    const w = pending.get(r.value.id);
    if (!w) return;
    pending.delete(r.value.id);
    clearTimeout(w.timer);
    if (!r.value.ok) {
      w.reject(Object.assign(new Error(r.value.error.message), { code: r.value.error.code }));
      return;
    }
    const v = validateCommandResult(w.type, r.value.p);
    if (!v.ok) {
      T.results.invalid += 1;
      T.rejected.push({ t: Date.now(), kind: `result:${w.type}`, error: v.error });
      w.reject(new Error(`invalid ${w.type} result: ${v.error}`));
      return;
    }
    w.resolve(v.value);
    return;
  }
  const ev = validateEventMessage(data);
  if (!ev.ok) {
    T.rejected.push({ t: Date.now(), kind: 'event', error: ev.error });
    return;
  }
  T.events.push({ seq: ++seq, t: Date.now(), type: ev.value.type, p: ev.value.p as unknown as Record<string, unknown> });
  if (T.events.length > 8000) T.events.splice(0, 2000);
  if (ev.value.type === 'needTicket') requestTicket();
}

embed();
