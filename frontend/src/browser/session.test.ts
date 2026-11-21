import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/idb', () => ({ idbGet: vi.fn(async () => undefined), idbPut: vi.fn(async () => 'tabs') }));

let last: typeof import('./session') | null = null;
async function fresh(): Promise<typeof import('./session')> {
  vi.resetModules();
  last = await import('./session');
  return last;
}

const channels: BroadcastChannel[] = [];
afterEach(() => {
  last?.closeSessionChannel();
  for (const c of channels.splice(0)) c.close();
  sessionStorage.clear();
});

/** Another GNOME page: answers pings on the app-origin channel like session.ts does. */
function otherPage(id = 'other-page'): BroadcastChannel {
  const c = new BroadcastChannel('gnome-app');
  c.onmessage = (ev: MessageEvent) => {
    const d = ev.data as { type?: string; id?: string };
    if (d?.type === 'ping') c.postMessage({ type: 'pong', to: d.id, from: id });
  };
  channels.push(c);
  return c;
}

describe('fresh-start detection (clear on exit, browser.startup)', () => {
  it('is a fresh start in a new browser tab with no other GNOME page', async () => {
    const s = await fresh();
    const k = await s.detectStart(60);
    expect(k).toEqual({ firstInTab: true, othersOpen: false });
    expect(s.isFreshStart(k)).toBe(true);
  });

  it('is not a fresh start after a reload of the same tab (sessionStorage marker)', async () => {
    sessionStorage.setItem('gnome:app-page:v1', '1');
    const s = await fresh();
    const k = await s.detectStart(60);
    expect(k.firstInTab).toBe(false);
    expect(s.isFreshStart(k)).toBe(false);
  });

  it('is not a fresh start while another GNOME page answers, and counts the other pages', async () => {
    otherPage('a');
    otherPage('b');
    const s = await fresh();
    // Generous waits: the pongs cross the event loop, which a full parallel test run keeps busy (a 120 ms wait
    // flaked there once).
    const k = await s.detectStart(800);
    expect(k).toEqual({ firstInTab: true, othersOpen: true });
    expect(s.isFreshStart(k)).toBe(false);
    expect(await s.otherAppPages(800)).toBe(2);
  });
});
