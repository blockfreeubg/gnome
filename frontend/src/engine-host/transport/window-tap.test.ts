/**
 * The engine-host realm's WebSocket tap (window-backends.ts installWindowTap; its own file: the tap is installed once
 * per module instance). A socket the realm's policy refuses is a failed open for the watchdog (worklist A2): Firefox
 * throws from the constructor (NS_ERROR_CONTENT_BLOCKED), Chromium fires `error` and no `close`.
 */
import { describe, expect, it } from 'vitest';
import type { WindowSocketEvent } from './backends';
import { windowScramjetBackend } from './window-backends';

class FakeNativeSocket extends EventTarget {
  static refused = new Set<string>();
  readonly url: string;
  constructor(url: string | URL) {
    if (FakeNativeSocket.refused.has(String(url))) throw new Error('NS_ERROR_CONTENT_BLOCKED');
    super();
    this.url = String(url);
  }
}

const win = { WebSocket: FakeNativeSocket, EventTarget, setTimeout, fetch } as unknown as Window & typeof globalThis;
const backend = windowScramjetBackend(win);
const events: WindowSocketEvent[] = [];
backend.onSocket((e) => events.push(e));
const Ws = (win as unknown as { WebSocket: new (url: string) => EventTarget }).WebSocket;
const brief = () => events.splice(0).map((e) => `${e.ev}${e.ev === 'close' ? `:${e.wasOpen ? 'open' : 'never'}` : ''}`);

describe('the engine-host WebSocket tap', () => {
  it('reports a socket whose constructor throws as a failed open, and rethrows', () => {
    FakeNativeSocket.refused.add('ws://127.0.0.1:1/');
    expect(() => new Ws('ws://127.0.0.1:1/')).toThrow(/CONTENT_BLOCKED/);
    expect(brief()).toEqual(['close:never']);
  });

  it('reports an error before open as a failed open, once (a later close adds nothing)', () => {
    const s = new Ws('ws://127.0.0.1:2/');
    s.dispatchEvent(new Event('error'));
    expect(brief()).toEqual(['connecting', 'close:never']); // Chromium: no close follows a CSP block
    s.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
    expect(brief()).toEqual([]);
  });

  it('an error after open leaves the drop to its close', () => {
    const s = new Ws('ws://127.0.0.1:3/');
    s.dispatchEvent(new Event('open'));
    s.dispatchEvent(new Event('error'));
    expect(brief()).toEqual(['connecting', 'open']);
    s.dispatchEvent(Object.assign(new Event('close'), { code: 1006 }));
    expect(brief()).toEqual(['close:open']);
  });
});
