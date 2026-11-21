// Driving the e2e driver page (`<app origin>/e2e-driver/`, lib/driver/driver.ts) and, through it, the real engine
// host. The App API keeps the spike's (tests/e2e/spike-engine-host/lib/drive.mjs) so ported suites look alike:
// waitInit, mark, eventsSince, waitFor, gnome, waitTabFrame, createTab, navigate, stats, close.
import { sleep } from '../../spike-engine-host/lib/procs.mjs';
import { APP_ORIGIN } from './config.mjs';

export { bodyText, readOut, withDeadline, FRAME_EVAL_MS } from '../../spike-engine-host/lib/drive.mjs';
import { withDeadline, FRAME_EVAL_MS } from '../../spike-engine-host/lib/drive.mjs';

/** Default per-load permissions (EnginePermissionSet): everything allowed, like a browser's defaults. */
export const ALLOW_ALL_PERMISSIONS = { autoplay: 'allow', fullscreen: 'allow', clipboard: 'allow' };

/**
 * Opens the driver page. `query`: engine, transport, route (default | profile:<id> | custom:<urls>), fallback, webrtc,
 * ticket=0, autoTicket=0, engines, combos (driver.ts header).
 */
export async function openApp(context, query = {}, { timeout = 60000, origin = APP_ORIGIN } = {}) {
  const page = await context.newPage();
  const app = new App(page);
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  await page.goto(`${origin}/e2e-driver/${qs ? `?${qs}` : ''}`);
  await app.waitInit(timeout);
  return app;
}

export class App {
  constructor(page) {
    this.page = page;
    /** tabId → the playwright Frame last found by name (see tabFrame). */
    this.frames = new Map();
    this.console = [];
    this.pageErrors = [];
    this.downloads = [];
    page.on('console', (m) => {
      // The start and the end of long texts (Firefox prints a logger's stack before its message).
      const text = m.text();
      const short = text.length > 600 ? `${text.slice(0, 400)} … ${text.slice(-200)}` : text;
      if (this.console.length < 4000) this.console.push({ t: Date.now(), type: m.type(), text: short, url: m.location()?.url?.slice(0, 160) });
    });
    page.on('pageerror', (e) => this.pageErrors.push(String(e).slice(0, 400)));
    page.on('download', (d) => this.downloads.push({ t: Date.now(), url: d.url(), suggestedFilename: d.suggestedFilename(), download: d }));
  }

  async waitInit(timeout = 60000) {
    await this.page.waitForFunction(() => window.gnomeTest && (window.gnomeTest.init || window.gnomeTest.initError), null, { timeout, polling: 100 });
    const r = await this.page.evaluate(() => ({ init: window.gnomeTest.init, error: window.gnomeTest.initError }));
    if (r.error) throw new Error(`engine host init failed: ${r.error}`);
    this.init = r.init;
    return r.init;
  }

  /** A raw protocol command (payload as ENGINE-PROTOCOL §4 defines it). */
  cmd(type, p = {}, timeout) {
    return this.page.evaluate(([t, pp, to]) => window.gnomeTest.cmd(t, pp, to), [type, p, timeout ?? null]).catch((e) => {
      throw new Error(String(e.message || e).replace(/^page\.evaluate: (Error: )?/, ''));
    });
  }

  async mark() {
    return this.page.evaluate(() => (window.gnomeTest.events.length ? window.gnomeTest.events[window.gnomeTest.events.length - 1].seq : 0));
  }

  async eventsSince(seq) {
    return this.page.evaluate((s) => window.gnomeTest.events.filter((e) => e.seq > s), seq);
  }

  /** Waits until pred(event) holds for an event newer than `since`; returns it or null. */
  async waitFor(since, pred, timeout = 30000) {
    const t0 = Date.now();
    let seen = since;
    for (;;) {
      const evs = await this.eventsSince(seen);
      for (const e of evs) {
        if (pred(e)) return e;
        seen = Math.max(seen, e.seq);
      }
      if (Date.now() - t0 > timeout) return null;
      await sleep(100);
    }
  }

  /** Evaluates `expr` in the driver page (window.gnomeTest: events, rejected, hellos, tickets, ...). */
  async gnome(expr, arg) {
    return this.page.evaluate(expr, arg);
  }

  /** The engine host's frame (proxy origin). */
  engineFrame() {
    return this.page.frames().find((f) => f.parentFrame() === this.page.mainFrame() && /\/engine\/$/.test(f.url())) || null;
  }

  /**
   * A tab's frame: the engine host names its iframe `tab-<id>` (lane a keeps the spike's naming). Scramjet renames the
   * frame's browsing context (`window.name`) in some loads, e.g. after a `tab.reload` in Chromium, so the Frame
   * found by name is kept per tab: playwright keeps one Frame per browsing context across its navigations, and a
   * replaced iframe (engine switch, tab closed) detaches it, so the lookup by name runs again.
   */
  tabFrame(tabId) {
    const named = this.page.frames().find((f) => f.name() === `tab-${tabId}`);
    if (named) {
      this.frames.set(tabId, named);
      return named;
    }
    const known = this.frames.get(tabId);
    if (known && !known.isDetached()) return known;
    this.frames.delete(tabId);
    return null;
  }

  async waitTabFrame(tabId, pred, timeout = 20000) {
    const t0 = Date.now();
    for (;;) {
      const f = this.tabFrame(tabId);
      if (f) {
        try {
          if (!pred || (await withDeadline(pred(f), Math.max(500, Math.min(FRAME_EVAL_MS, timeout - (Date.now() - t0)))))) return f;
        } catch {
          /* navigating, or a stuck read */
        }
      }
      if (Date.now() - t0 > timeout) return null;
      await sleep(150);
    }
  }

  async createTab(tabId, opts = {}) {
    const start = opts.start ?? (opts.url ? { kind: 'url', url: opts.url } : { kind: 'blank' });
    return this.cmd('tab.create', {
      tabId,
      active: opts.active ?? true,
      engine: opts.engine ?? null,
      zoom: opts.zoom ?? 1,
      start,
      permissions: opts.permissions ?? ALLOW_ALL_PERMISSIONS,
    });
  }

  /** Navigates (or creates the tab at `url`) and waits for tab.loaded / tab.error. */
  async navigate(tabId, url, { engine, timeout = 60000, create = false, permissions } = {}) {
    const since = await this.mark();
    const t0 = Date.now();
    let started;
    try {
      started = create
        ? await this.createTab(tabId, { url, engine, permissions })
        : await this.cmd('tab.navigate', { tabId, url, engine: engine ?? null, permissions: permissions ?? ALLOW_ALL_PERMISSIONS });
    } catch (e) {
      return { ok: false, error: String(e.message || e), ms: Date.now() - t0, events: [] };
    }
    const end = await this.waitFor(since, (e) => (e.type === 'tab.loaded' || e.type === 'tab.error') && e.p.tabId === tabId, timeout);
    const events = await this.eventsSince(since);
    const mine = events.filter((e) => e.p && (e.p.tabId === tabId || e.p.openerTabId === tabId));
    const committed = mine.filter((e) => e.type === 'tab.committed').pop() || null;
    return {
      ok: end?.type === 'tab.loaded',
      ms: end ? end.t - t0 : null,
      engine: end?.p?.engine || committed?.p?.engine || started?.engine || null,
      startedEngine: started?.engine || null,
      error: end?.type === 'tab.error' ? end.p : end ? null : 'timeout waiting for tab.loaded/tab.error',
      committed: committed?.p || null,
      switched: mine.filter((e) => e.type === 'tab.engineSwitched').map((e) => e.p),
      title: mine.filter((e) => e.type === 'tab.title').pop()?.p.title ?? null,
      events: mine,
    };
  }

  /** The engine host's counters (the `diagnostics` command). */
  async stats() {
    return this.cmd('diagnostics', {});
  }

  /** Current status (the `status` command). */
  async status() {
    return this.cmd('status', {});
  }

  async close() {
    try {
      await this.page.close();
    } catch {
      /* already closed */
    }
  }
}
