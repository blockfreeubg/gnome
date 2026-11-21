/**
 * BrowserBridge — how the rest of the app asks the browser view to open things.
 *
 * Features call `openInput(text)` (omnibox semantics), `openUrl(href)` or `openInternal(path)`. Until the browser
 * implementation registers itself with `setBridge()`, the default bridge queues URL requests (nothing is lost) and
 * navigates to /browse; when a real bridge registers, the queue is replayed into it in order.
 */
import { createSubscriber } from 'svelte/reactivity';
import { appEvents } from '../lib/events';
import { parseOmnibox, type OmniboxResult } from '../lib/url';
import { navigate, router } from '../app/router.svelte';
import { settings } from '../settings/store.svelte';

export interface OpenOptions {
  /** Open in a new tab instead of the active one. */
  newTab?: boolean;
  /** Do not switch to the new tab / the browser view. */
  background?: boolean;
  /** http:// URL to retry if an upgraded https:// navigation cannot connect (from parseOmnibox). */
  fallbackHref?: string;
}

export interface BrowserBridge {
  readonly id: string;
  /** Opens an http(s) URL (or about:blank) in the browser view. */
  openUrl(href: string, opts?: OpenOptions): void | Promise<void>;
  /** Opens a GNOME page (route path such as "/settings" from gnome://settings). */
  openInternal(path: string, opts?: OpenOptions): void | Promise<void>;
  /** Moves focus to the address bar. */
  focusOmnibox(): void;
}

export interface PendingRequest {
  id: number;
  href: string;
  opts: OpenOptions;
  at: number;
}

let queue: PendingRequest[] = [];
let nextId = 0;
const updates = new Set<() => void>();
const subscribe = createSubscriber((update) => {
  updates.add(update);
  return () => updates.delete(update);
});

function changed(): void {
  for (const u of updates) u();
}

/** Shows the browser view unless it is already the current route (avoids stacking history entries). */
function showBrowser(): void {
  if (router.current?.route.id !== 'browse') void navigate('/browse');
}

const defaultBridge: BrowserBridge = {
  id: 'default',
  openUrl(href, opts = {}) {
    queue = [...queue, { id: ++nextId, href, opts, at: Date.now() }];
    changed();
    if (!opts.background) showBrowser();
  },
  openInternal(path) {
    void navigate(path);
  },
  focusOmnibox() {
    showBrowser();
  },
};

let active: BrowserBridge = defaultBridge;

export function getBridge(): BrowserBridge {
  return active;
}

/**
 * Registers the browser implementation. Queued requests are replayed into it immediately.
 * Returns an unregister function (restores the default queueing bridge).
 */
export function setBridge(bridge: BrowserBridge): () => void {
  active = bridge;
  const replay = queue;
  queue = [];
  changed();
  for (const r of replay) void bridge.openUrl(r.href, r.opts);
  appEvents.emit('bridge:changed', { id: bridge.id });
  return () => {
    if (active === bridge) {
      active = defaultBridge;
      appEvents.emit('bridge:changed', { id: defaultBridge.id });
    }
  };
}

/** Requests waiting for a browser implementation (reactive in components). */
export function pendingRequests(): readonly PendingRequest[] {
  subscribe();
  return queue;
}

/** Drops one queued request (e.g. the user removed it before the browser started). */
export function removePending(id: number): void {
  const next = queue.filter((r) => r.id !== id);
  if (next.length === queue.length) return;
  queue = next;
  changed();
}

/** Removes and returns queued requests (for a browser host that prefers to pull). */
export function takePending(): PendingRequest[] {
  const out = queue;
  queue = [];
  changed();
  return out;
}

export function openUrl(href: string, opts?: OpenOptions): void | Promise<void> {
  return active.openUrl(href, opts);
}

export function openInternal(path: string, opts?: OpenOptions): void | Promise<void> {
  return active.openInternal(path, opts);
}

/** Parses omnibox-style input with the user's search settings and opens the result. Returns what was opened. */
export function openInput(input: string, opts: OpenOptions = {}): OmniboxResult | null {
  const b = settings.value.browser;
  const result = parseOmnibox(input, { searchEngine: b.searchEngine, customSearchUrl: b.customSearchUrl });
  if (!result) return null;
  if (result.kind === 'internal') void active.openInternal(result.href, opts);
  else void active.openUrl(result.href, result.fallbackHref ? { ...opts, fallbackHref: result.fallbackHref } : opts);
  return result;
}

/**
 * In-app link for an external page: `/browse?url=<href>`. Plain clicks should call openUrl(); the href makes
 * middle-click / "open in new tab" open GNOME itself (never the site directly, which would bypass the proxy).
 */
export function browseLink(href: string): string {
  return `/browse?url=${encodeURIComponent(href)}`;
}
