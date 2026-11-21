/**
 * The parts of window-backends.ts that need no browser: the Scramjet connect wrapper behind useHooks() (Wave B step 3
 * blocks WebSockets of Scramjet pages through it), the probe's reading of a gateway answer, and the engine-host
 * WebSocket tap. The transports themselves are exercised by the e2e suites.
 */
import { describe, expect, it } from 'vitest';
import { windowProbe, windowScramjetBackend } from './window-backends';

type Cb = (...a: unknown[]) => void;

/** A minimal window: the tap wraps its WebSocket class; timers run for real (the block path defers its callbacks). */
function fakeWindow(fetchImpl?: typeof fetch) {
  class FakeNativeSocket extends EventTarget {
    constructor(readonly url: string | URL) {
      super();
    }
  }
  const win = { WebSocket: FakeNativeSocket, EventTarget, setTimeout, fetch: fetchImpl ?? fetch };
  return win as unknown as Window & typeof globalThis;
}

function transport() {
  const calls: unknown[][] = [];
  return {
    calls,
    t: {
      init: async () => {},
      request: async () => ({ body: null, headers: [], status: 200 }),
      connect: (...a: unknown[]) => {
        calls.push(a);
        return [() => {}, () => {}];
      },
    },
  };
}

describe('the Scramjet connect wrapper (useHooks)', () => {
  it('allowed: the transport connects; blocked: it never does, and the page sees error + close 1006', async () => {
    const backend = windowScramjetBackend(fakeWindow());
    const { t, calls } = transport();
    const verdicts: Array<'allow' | 'block'> = ['allow', 'block'];
    const asked: string[] = [];
    backend.wrapConnect(t, (url) => {
      asked.push(url);
      return verdicts.shift() ?? 'allow';
    });
    const events: unknown[] = [];
    const cb = (name: string): Cb => (...a: unknown[]) => events.push([name, ...a]);
    t.connect(new URL('wss://a.example/x'), [], [], cb('open'), cb('message'), cb('close'), cb('error'));
    expect(calls).toHaveLength(1);
    const pair = (t.connect as (...a: unknown[]) => unknown)(new URL('wss://b.example/y'), [], [], cb('open'), cb('message'), cb('close'), cb('error'));
    expect(calls).toHaveLength(1);
    expect(Array.isArray(pair) && pair.length === 2).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual([
      ['error', 'blocked'],
      ['close', 1006, 'blocked'],
    ]);
    expect(asked).toEqual(['wss://a.example/x', 'wss://b.example/y']);
  });

  it('wraps a transport once', () => {
    const backend = windowScramjetBackend(fakeWindow());
    const { t, calls } = transport();
    let asked = 0;
    backend.wrapConnect(t, () => {
      asked += 1;
      return 'allow';
    });
    backend.wrapConnect(t, () => {
      asked += 10;
      return 'allow';
    });
    t.connect(new URL('wss://a.example/'), [], [], () => {}, () => {}, () => {}, () => {});
    expect([asked, calls.length]).toEqual([1, 1]);
  });
});

describe('the probe reads the gateway’s answer', () => {
  it('status, Retry-After and error.code of a JSON body; null on a network error', async () => {
    const answers: Array<Response | Error> = [
      new Response('{"error":{"code":"wisp_upstream_unavailable","retry_after_s":10}}', { status: 503, headers: { 'retry-after': '10' } }),
      new Response('{"error":{"code":"wisp_ticket_expired"}}', { status: 401 }),
      new Response('Upgrade Required', { status: 426 }),
      new Error('network down'),
    ];
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push([url, init]);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a as Response;
    }) as unknown as typeof fetch;
    const probe = windowProbe(fakeWindow(fetchImpl));
    expect(await probe('http://127.0.0.1:1/wisp/?t=x&/')).toEqual({ status: 503, retryAfter: '10', errorCode: 'wisp_upstream_unavailable' });
    expect(await probe('http://127.0.0.1:1/wisp/?t=x&/')).toEqual({ status: 401, retryAfter: null, errorCode: 'wisp_ticket_expired' });
    expect(await probe('http://127.0.0.1:1/wisp/?t=x&/')).toEqual({ status: 426, retryAfter: null, errorCode: null });
    expect(await probe('http://127.0.0.1:1/wisp/?t=x&/')).toBeNull();
    // a plain same-origin GET: no cookies, no cache, redirects not followed
    expect(seen[0]?.[1]).toEqual({ cache: 'no-store', credentials: 'omit', redirect: 'manual' });
  });
});
