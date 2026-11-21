import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appEvents } from '../lib/events';
import { loadTldList } from '../lib/url';

const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined), router: { current: null as null | { route: { id: string } } } }));
vi.mock('../app/router.svelte', () => nav);
vi.mock('../lib/idb', () => ({ idbGet: vi.fn(async () => undefined), idbPut: vi.fn(async () => 'current') }));

const bridge = await import('./bridge');

beforeEach(async () => {
  await loadTldList();
  bridge.takePending();
  nav.navigate.mockClear();
  nav.router.current = null;
});

describe('default bridge (no browser registered yet)', () => {
  it('queues URLs and shows the browser view', () => {
    bridge.openUrl('https://example.com/', { newTab: true });
    expect(bridge.pendingRequests().map((r) => [r.href, r.opts])).toEqual([['https://example.com/', { newTab: true }]]);
    expect(nav.navigate).toHaveBeenCalledWith('/browse');
  });

  it('does not stack history entries when the browser view is already shown', () => {
    nav.router.current = { route: { id: 'browse' } };
    bridge.openUrl('https://example.com/');
    bridge.getBridge().focusOmnibox();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('stays put for background requests', () => {
    bridge.openUrl('https://example.com/', { newTab: true, background: true });
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(bridge.pendingRequests()).toHaveLength(1);
  });

  it('opens internal pages through the router', () => {
    bridge.openInternal('/settings');
    expect(nav.navigate).toHaveBeenCalledWith('/settings');
  });

  it('lets queued requests be removed', () => {
    bridge.openUrl('https://a.example/');
    bridge.openUrl('https://b.example/');
    const [first] = bridge.pendingRequests();
    bridge.removePending(first!.id);
    expect(bridge.pendingRequests().map((r) => r.href)).toEqual(['https://b.example/']);
  });
});

describe('openInput', () => {
  it('parses omnibox text with the user’s search settings', () => {
    expect(bridge.openInput('example.com')).toMatchObject({ kind: 'url', href: 'https://example.com/' });
    expect(bridge.pendingRequests().at(-1)).toMatchObject({ href: 'https://example.com/', opts: { fallbackHref: 'http://example.com/' } });
    expect(bridge.openInput('tie a knot')?.kind).toBe('search');
    expect(bridge.openInput('gnome://history')).toEqual({ kind: 'internal', href: '/history' });
    expect(nav.navigate).toHaveBeenLastCalledWith('/history');
    expect(bridge.openInput('   ')).toBeNull();
  });
});

describe('registering a browser implementation', () => {
  it('replays the queue in order, routes later calls to it and restores the default on unregister', () => {
    bridge.openUrl('https://one.example/');
    bridge.openUrl('https://two.example/', { newTab: true });
    const opened: Array<[string, unknown]> = [];
    const events: string[] = [];
    const offEvents = appEvents.on('bridge:changed', (e) => events.push(e.id));
    const off = bridge.setBridge({
      id: 'browser',
      openUrl: (href, opts) => void opened.push([href, opts]),
      openInternal: () => undefined,
      focusOmnibox: () => undefined,
    });
    expect(opened).toEqual([
      ['https://one.example/', {}],
      ['https://two.example/', { newTab: true }],
    ]);
    expect(bridge.pendingRequests()).toEqual([]);
    bridge.openUrl('https://three.example/');
    expect(opened).toHaveLength(3);
    expect(bridge.getBridge().id).toBe('browser');
    off();
    offEvents();
    expect(bridge.getBridge().id).toBe('default');
    expect(events).toEqual(['browser', 'default']);
  });

  it('builds in-app links for external pages', () => {
    expect(bridge.browseLink('https://example.com/?a=1&b=2')).toBe('/browse?url=https%3A%2F%2Fexample.com%2F%3Fa%3D1%26b%3D2');
  });
});
