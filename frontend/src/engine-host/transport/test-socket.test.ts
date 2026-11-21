/**
 * The custom Wisp servers' test socket (window-backends.ts windowTestSocket; manager.ts #customReachable): it must not
 * leave a connecting socket behind for a server that never answers (quality review, integration part 2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { windowTestSocket } from './window-backends';

class SilentSocket extends EventTarget {
  static all: SilentSocket[] = [];
  closed = 0;
  constructor(readonly url: string) {
    super();
    SilentSocket.all.push(this);
  }
  close(): void {
    this.closed++;
  }
}

const fakeWin = () =>
  ({
    WebSocket: SilentSocket,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  }) as unknown as Window & typeof globalThis;

afterEach(() => {
  vi.useRealTimers();
  SilentSocket.all = [];
});

describe('windowTestSocket', () => {
  it('gives up after its timeout and closes the socket of a server that never answers', async () => {
    vi.useFakeTimers();
    const p = windowTestSocket(fakeWin())('ws://blackhole.example/', 4000);
    await vi.advanceTimersByTimeAsync(3999);
    expect(SilentSocket.all[0]!.closed).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toBe(false);
    expect(SilentSocket.all[0]!.closed).toBe(1);
  });

  it('an open answers true and closes the socket at once; the timer then does nothing more', async () => {
    vi.useFakeTimers();
    const p = windowTestSocket(fakeWin())('ws://live.example/', 4000);
    SilentSocket.all[0]!.dispatchEvent(new Event('open'));
    await expect(p).resolves.toBe(true);
    expect(SilentSocket.all[0]!.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(SilentSocket.all[0]!.closed).toBe(1);
  });
});
