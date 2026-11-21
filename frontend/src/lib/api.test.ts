import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  buildUrl,
  ensureSession,
  getConfig,
  getSession,
  invalidateSession,
  isApiError,
  request,
  requestWispTicket,
  setAccessCodePrompt,
} from './api';
import { appEvents } from './events';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const gnomeError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response =>
  json(status, { error: { code, message, ...extra } });

/** Awaits a request that must fail and returns its ApiError. */
async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected the request to fail');
}

let calls: Array<{ url: string; init: RequestInit }> = [];
function mockFetch(handler: Handler): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }),
  );
}

const CONFIG = {
  version: '0.1.0',
  access_mode: 'open',
  registration: 'open',
  features: { accounts: true, sync: true, games: true, vpn_gateway: false, thumb_proxy: true },
  wisp: { path: '/wisp/', ticket_ttl_s: 86400, profiles: [], custom_servers: true },
  engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
  proxy: { origin: 'http://127.0.0.1:8081', isolated: true },
  source_url: null,
  limits: { max_ws_per_session: 16 },
};

beforeEach(() => {
  invalidateSession();
  setAccessCodePrompt(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('sends JSON, asks for JSON and marks state-changing requests (CSRF contract)', async () => {
    mockFetch(() => json(200, { ok: true }));
    await api.post('/api/x', { a: 1 });
    await api.get('/api/y', { query: { q: 'a b', empty: '', none: null, n: 2, flag: false } });
    const [post, get] = calls;
    const postHeaders = post!.init.headers as Record<string, string>;
    expect(post!.init.method).toBe('POST');
    expect(post!.init.body).toBe('{"a":1}');
    expect(postHeaders['Content-Type']).toBe('application/json');
    expect(postHeaders['X-GNOME-Request']).toBe('1');
    expect(postHeaders.Accept).toBe('application/json');
    expect(post!.init.credentials).toBe('same-origin');
    expect(get!.url).toBe('/api/y?q=a+b&n=2&flag=false');
    expect((get!.init.headers as Record<string, string>)['X-GNOME-Request']).toBeUndefined();
  });

  it('marks every non-GET/HEAD method', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      await request('/api/z', { method });
      expect((calls.at(-1)!.init.headers as Record<string, string>)['X-GNOME-Request']).toBe('1');
    }
    await request('/api/z', { method: 'HEAD' });
    expect((calls.at(-1)!.init.headers as Record<string, string>)['X-GNOME-Request']).toBeUndefined();
  });

  it('returns undefined for 204 and parsed JSON otherwise', async () => {
    mockFetch((url) => (url.endsWith('/empty') ? new Response(null, { status: 204 }) : json(200, { n: 1 })));
    expect(await api.get('/api/empty')).toBeUndefined();
    expect(await api.get<{ n: number }>('/api/full')).toEqual({ n: 1 });
  });

  it('turns the documented error envelope into a typed ApiError', async () => {
    mockFetch(() => gnomeError(422, 'validation_failed', 'Check the form', { fields: { username: 'too short' } }));
    const err = await failure(api.post('/api/auth/register', {}));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'validation_failed',
      message: 'Check the form',
      fields: { username: 'too short' },
      fromGnome: true,
    });
    expect(isApiError(err, 'validation_failed')).toBe(true);
    expect(isApiError(err, 'conflict')).toBe(false);
  });

  it('reads retry hints from the body or the Retry-After header', async () => {
    mockFetch(() => gnomeError(429, 'rate_limited', 'Slow down', { retry_after_s: 12 }));
    expect((await failure(api.get('/api/x'))).retryAfterS).toBe(12);
    mockFetch(() => json(429, { error: { code: 'rate_limited', message: 'Slow down' } }, { 'Retry-After': '30' }));
    const e = await failure(api.get('/api/x'));
    expect(e.retryAfterS).toBe(30);
    expect(e.retryable).toBe(true);
  });

  it('maps statuses when the body is not GNOME’s envelope (proxies, other apps)', async () => {
    mockFetch(() => json(401, { error: 'Sign in first.', needAccount: true }));
    const foreign = await failure(api.get('/api/config'));
    expect(foreign).toMatchObject({ status: 401, code: 'unauthorized', fromGnome: false });
    mockFetch(() => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const gateway = await failure(api.get('/api/config'));
    expect(gateway).toMatchObject({ status: 502, code: 'internal', fromGnome: false, retryable: true });
    expect(gateway.body).toBe('<html>Bad gateway</html>');
  });

  it('recognizes every documented error code, including method_not_allowed and the server timeout', async () => {
    for (const [status, code] of [
      [400, 'bad_request'],
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [405, 'method_not_allowed'],
      [409, 'conflict'],
      [413, 'payload_too_large'],
      [422, 'validation_failed'],
      [429, 'rate_limited'],
      [401, 'access_code_required'],
      [401, 'login_required'],
      [500, 'internal'],
      [503, 'unavailable'],
      [503, 'timeout'],
    ] as const) {
      mockFetch(() => gnomeError(status, code, 'm'));
      expect(await failure(api.post('/api/x', {}))).toMatchObject({ status, code, fromGnome: true });
    }
    const timeout = await failure(api.get('/api/x'));
    expect(timeout.retryable).toBe(true);
    // Without the envelope: statuses map to the same codes (a reverse proxy's 405 / 504).
    mockFetch(() => new Response('nope', { status: 405, headers: { Allow: 'GET' } }));
    expect((await failure(api.put('/api/x', {}))).code).toBe('method_not_allowed');
    mockFetch(() => new Response('gateway timeout', { status: 504 }));
    expect(await failure(api.get('/api/x'))).toMatchObject({ code: 'timeout', fromGnome: false, retryable: true });
  });

  it('rejects non-JSON success responses (the dev server answering with index.html)', async () => {
    mockFetch(() => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(api.get('/api/config')).rejects.toMatchObject({ code: 'invalid_response' });
    mockFetch(() => new Response('{broken', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(api.get('/api/config')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports network failures, timeouts and cancellation distinctly', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.get('/api/x')).rejects.toMatchObject({ code: 'network_error', status: 0, retryable: true });

    const hang: Handler = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    mockFetch(hang);
    await expect(api.get('/api/slow', { timeoutMs: 20 })).rejects.toMatchObject({ code: 'timeout' });

    const ctrl = new AbortController();
    const pending = api.get('/api/slow', { signal: ctrl.signal, timeoutMs: 5000 });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retryable: false });
  });

  it('passes FormData, Blob and strings through untouched', async () => {
    mockFetch(() => json(200, {}));
    await api.post('/api/upload', 'raw text');
    expect(calls[0]!.init.body).toBe('raw text');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('buildUrl appends to existing queries', () => {
    expect(buildUrl('/api/games?sort=new', { q: 'x' })).toBe('/api/games?sort=new&q=x');
    expect(buildUrl('/api/games', {})).toBe('/api/games');
  });
});

describe('getConfig', () => {
  it('returns the configuration', async () => {
    mockFetch(() => json(200, CONFIG));
    expect(await getConfig()).toEqual(CONFIG);
  });

  it('fills members an older server omits with the documented defaults', async () => {
    // What gnome-server 0.1.0 answers before the origins/tickets work lands: no ticket_ttl_s, single-origin proxy.
    const older = {
      version: '0.1.0',
      access_mode: 'open',
      registration: 'open',
      features: { accounts: true, sync: true, games: false, vpn_gateway: false, thumb_proxy: false },
      wisp: { path: '/wisp/', profiles: [] },
      engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
      proxy: { origin: 'http://127.0.0.1:8080', isolated: false },
      source_url: null,
      limits: { max_ws_per_session: 16 },
    };
    mockFetch(() => json(200, older));
    const cfg = await getConfig();
    expect(cfg.wisp).toEqual({ path: '/wisp/', ticket_ttl_s: 3600, profiles: [], custom_servers: false });
    expect(cfg.proxy).toEqual({ origin: 'http://127.0.0.1:8080', isolated: false });

    mockFetch(() => json(200, { version: '0.0.9', access_mode: 'code', features: {} }));
    const minimal = await getConfig();
    expect(minimal).toMatchObject({
      registration: 'closed',
      features: { accounts: false, sync: false, games: false, vpn_gateway: false, thumb_proxy: false },
      wisp: { path: '/wisp/', ticket_ttl_s: 3600, profiles: [] },
      engines: { default: 'scramjet', scramjet: true, ultraviolet: true },
      proxy: { origin: null, isolated: false },
      source_url: null,
      limits: { max_ws_per_session: 16 },
    });
  });

  it('keeps only http(s) URLs for links and origins, and well-formed VPN profiles', async () => {
    mockFetch(() =>
      json(200, {
        ...CONFIG,
        source_url: 'javascript:alert(1)',
        proxy: { origin: 'https://p.example.com/ignored/path', isolated: true },
        wisp: {
          path: '/wisp/',
          ticket_ttl_s: 3600,
          profiles: [
            { id: 'se-got', label: 'Sweden · Gothenburg', country_code: 'se', city: 'Gothenburg', path: '/wisp/p/se-got/' },
            { id: 7, label: 'broken' },
          ],
        },
      }),
    );
    const cfg = await getConfig();
    expect(cfg.source_url).toBeNull();
    expect(cfg.proxy.origin).toBe('https://p.example.com');
    expect(cfg.wisp.ticket_ttl_s).toBe(3600);
    expect(cfg.wisp.profiles.map((p) => p.id)).toEqual(['se-got']);
    mockFetch(() => json(200, { ...CONFIG, source_url: 'https://example.com/gnome-source' }));
    expect((await getConfig()).source_url).toBe('https://example.com/gnome-source');
  });

  it('rejects JSON that is not a GNOME configuration', async () => {
    mockFetch(() => json(200, { hello: 'world' }));
    await expect(getConfig()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ensureSession', () => {
  it('creates the session once for concurrent callers and reuses it', async () => {
    mockFetch(() => json(200, { session: { kind: 'anonymous', expires_at: Date.now() + 30 * 86_400_000 } }));
    const seen: unknown[] = [];
    const off = appEvents.on('session:changed', (s) => seen.push(s));
    const [a, b] = await Promise.all([ensureSession(), ensureSession()]);
    await ensureSession();
    off();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect(a).toBe(b);
    expect(getSession()?.kind).toBe('anonymous');
    expect(seen).toHaveLength(1);
  });

  it('refreshes a session that is about to expire, or on force', async () => {
    mockFetch(() => json(200, { session: { kind: 'anonymous', expires_at: Date.now() + 60_000 } }));
    await ensureSession();
    await ensureSession(); // expires within the 5 min margin → refresh
    expect(calls).toHaveLength(2);
    mockFetch(() => json(200, { session: { kind: 'user', expires_at: Date.now() + 86_400_000 } }));
    await ensureSession({ force: true });
    expect(getSession()?.kind).toBe('user');
  });

  it('asks for the access code in code mode, keeping the prompt open on a wrong code', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { access_code?: string };
      if (body.access_code === 'correct horse') return json(200, { session: { kind: 'anonymous', expires_at: Date.now() + 86_400_000 } });
      if (body.access_code === 'spam') return gnomeError(429, 'rate_limited', 'Too many', { retry_after_s: 9 });
      return gnomeError(401, 'access_code_required', 'Access code required');
    });
    const messages: Array<string | null> = [];
    setAccessCodePrompt(async ({ submit }) => {
      messages.push(await submit('wrong'));
      messages.push(await submit('spam'));
      messages.push(await submit('  correct horse  '));
      return true;
    });
    const s = await ensureSession();
    expect(s.kind).toBe('anonymous');
    expect(messages).toEqual(['That access code is not valid.', 'Too many attempts. Try again in 9 s.', null]);
    expect(JSON.parse(String(calls.at(-1)!.init.body))).toEqual({ access_code: 'correct horse' });
  });

  it('rejects when the access code prompt is cancelled', async () => {
    mockFetch(() => gnomeError(401, 'access_code_required', 'Access code required'));
    setAccessCodePrompt(async () => false);
    await expect(ensureSession()).rejects.toMatchObject({ code: 'access_code_required' });
    expect(getSession()).toBeNull();
  });

  it('announces login_required in accounts mode', async () => {
    mockFetch(() => gnomeError(401, 'login_required', 'Sign in to use this server.'));
    const events: unknown[] = [];
    const off = appEvents.on('session:login-required', (e) => events.push(e));
    await expect(ensureSession()).rejects.toMatchObject({ code: 'login_required' });
    off();
    expect(events).toEqual([{ message: 'Sign in to use this server.' }]);
  });
});

describe('requestWispTicket', () => {
  const ticket = { ticket: 'w1.1800000000.abc.mac', expires_at: 1_800_000_000_000, wisp_url: 'ws://127.0.0.1:8081/wisp/' };

  it('mints a ticket (CSRF header included)', async () => {
    mockFetch(() => json(200, ticket, { date: 'Thu, 12 Nov 2026 07:00:00 GMT' }));
    expect(await requestWispTicket()).toEqual({
      ticket: ticket.ticket,
      expiresAt: ticket.expires_at,
      wispUrl: ticket.wisp_url,
      date: 'Thu, 12 Nov 2026 07:00:00 GMT',
    });
    expect(calls[0]!.url).toBe('/api/wisp/ticket');
    expect((calls[0]!.init.headers as Record<string, string>)['X-GNOME-Request']).toBe('1');
  });

  it('creates a session (with the access code) and retries once when the server needs one', async () => {
    let hasSession = false;
    mockFetch((url, init) => {
      if (url === '/api/session') {
        const body = JSON.parse(String(init.body)) as { access_code?: string };
        if (body.access_code !== 'letmein') return gnomeError(401, 'access_code_required', 'Access code required');
        hasSession = true;
        return json(200, { session: { kind: 'anonymous', expires_at: Date.now() + 86_400_000 } });
      }
      return hasSession ? json(200, ticket) : gnomeError(401, 'access_code_required', 'Access code required');
    });
    setAccessCodePrompt(async ({ submit }) => (await submit('letmein')) === null);
    expect((await requestWispTicket()).ticket).toBe(ticket.ticket);
    expect(calls.map((c) => c.url)).toEqual(['/api/wisp/ticket', '/api/session', '/api/session', '/api/wisp/ticket']);
  });

  it('reports a missing Date header as null', async () => {
    mockFetch(() => json(200, ticket));
    expect((await requestWispTicket()).date).toBeNull();
  });

  it('never prompts or emits events when not interactive (mints started by engine events)', async () => {
    let prompted = 0;
    setAccessCodePrompt(async () => {
      prompted++;
      return false;
    });
    const events: unknown[] = [];
    const off = appEvents.on('session:login-required', (e) => events.push(e));
    mockFetch(() => gnomeError(401, 'access_code_required', 'Access code required'));
    await expect(requestWispTicket({ interactive: false })).rejects.toMatchObject({ code: 'access_code_required' });
    expect(calls.map((c) => c.url)).toEqual(['/api/wisp/ticket']);
    mockFetch(() => gnomeError(401, 'login_required', 'Sign in to use this server.'));
    await expect(requestWispTicket({ interactive: false })).rejects.toMatchObject({ code: 'login_required' });
    off();
    expect(prompted).toBe(0);
    expect(events).toEqual([]);
  });

  it('rejects malformed answers', async () => {
    mockFetch(() => json(200, { ticket: 42 }));
    await expect(requestWispTicket()).rejects.toMatchObject({ code: 'invalid_response' });
    // The Wisp endpoint must be a WebSocket URL (it is handed to the engine host as is).
    for (const wisp_url of ['https://p.example.com/wisp/', 'javascript:alert(1)', '/wisp/']) {
      mockFetch(() => json(200, { ...ticket, wisp_url }));
      await expect(requestWispTicket()).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});
