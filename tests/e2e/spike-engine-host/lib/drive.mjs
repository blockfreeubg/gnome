// Driving the app page (APP origin) and, through it, the engine host.
import { APP_ORIGIN } from './config.mjs';
import { sleep } from './procs.mjs';

// playwright-core 1.64 + Firefox 157: frame.evaluate() on a tab iframe can stay pending forever after a GNOME
// location.replace() navigation (docs/research/spike-engine-host.md, limitations). Every frame read below gets a
// deadline, so a stuck read becomes a failed read (null) instead of a stalled suite.
export const FRAME_EVAL_MS = 8000;
export function withDeadline(p, ms = FRAME_EVAL_MS, label = 'frame.evaluate') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}: no answer within ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function openApp(context, query = {}, { timeout = 60000, origin = APP_ORIGIN } = {}) {
  const page = await context.newPage();
  const app = new App(page);
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString();
  await page.goto(`${origin}/${qs ? `?${qs}` : ''}`);
  await app.waitInit(timeout);
  return app;
}

export class App {
  constructor(page) {
    this.page = page;
    this.console = [];
    this.pageErrors = [];
    page.on('console', (m) => {
      if (this.console.length < 4000) this.console.push({ t: Date.now(), type: m.type(), text: m.text().slice(0, 400), url: m.location()?.url?.slice(0, 160) });
    });
    page.on('pageerror', (e) => this.pageErrors.push(String(e).slice(0, 400)));
    this.downloads = [];
    page.on('download', (d) => this.downloads.push({ t: Date.now(), url: d.url(), suggestedFilename: d.suggestedFilename(), download: d }));
  }

  async waitInit(timeout = 60000) {
    await this.page.waitForFunction(() => window.gnomeTest && (window.gnomeTest.init || window.gnomeTest.initError), null, { timeout, polling: 100 });
    const r = await this.page.evaluate(() => ({ init: window.gnomeTest.init, error: window.gnomeTest.initError }));
    if (r.error) throw new Error(`app init failed: ${r.error}`);
    this.init = r.init;
    return r.init;
  }

  cmd(type, p = {}, timeout = 15000) {
    return this.page.evaluate(([t, pp, to]) => window.gnomeTest.cmd(t, pp, to), [type, p, timeout]);
  }

  async mark() {
    return this.page.evaluate(() => (window.gnomeTest.events.length ? window.gnomeTest.events[window.gnomeTest.events.length - 1].seq : 0));
  }

  async eventsSince(seq) {
    return this.page.evaluate((s) => window.gnomeTest.events.filter((e) => e.seq > s), seq);
  }

  // Wait until pred(event) is true for an event newer than `since`; returns the event or null.
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

  async gnome(expr, arg) {
    return this.page.evaluate(expr, arg);
  }

  tabFrame(tabId) {
    return this.page.frames().find((f) => f.name() === `tab-${tabId}`) || null;
  }

  async waitTabFrame(tabId, pred, timeout = 20000) {
    const t0 = Date.now();
    for (;;) {
      const f = this.tabFrame(tabId);
      if (f) {
        try { if (!pred || (await withDeadline(pred(f), Math.max(500, Math.min(FRAME_EVAL_MS, timeout - (Date.now() - t0)))))) return f; } catch { /* navigating, or a stuck read */ }
      }
      if (Date.now() - t0 > timeout) return null;
      await sleep(150);
    }
  }

  async createTab(tabId, opts = {}) {
    return this.cmd('tab.create', { tabId, active: true, ...opts });
  }

  // Navigate and wait for the outcome: loaded (possibly after a fallback), error, or timeout.
  async navigate(tabId, url, { engine, timeout = 60000, create = false } = {}) {
    const since = await this.mark();
    const t0 = Date.now();
    let started;
    try {
      started = create ? await this.createTab(tabId, { url, engine }) : await this.cmd('tab.navigate', { tabId, url, engine });
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
      loadMs: end?.type === 'tab.loaded' ? end.p.ms : null,
      engine: end?.p?.engine || committed?.p?.engine || started?.engine || null,
      startedEngine: started?.engine || null,
      error: end?.type === 'tab.error' ? end.p : end ? null : 'timeout waiting for tab.loaded/tab.error',
      committed: committed?.p || null,
      switched: mine.filter((e) => e.type === 'tab.engineSwitched').map((e) => e.p),
      title: mine.filter((e) => e.type === 'tab.title').pop()?.p.title ?? null,
      events: mine,
    };
  }

  async stats() {
    return this.cmd('test.stats');
  }

  async close() {
    try { await this.page.close(); } catch { /* already closed */ }
  }
}

// Read #out JSON (or body text) from a tab frame, waiting until it is no longer "pending".
export async function readOut(app, tabId, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const f = app.tabFrame(tabId);
    if (f) {
      try {
        const left = Math.max(500, Math.min(FRAME_EVAL_MS, timeout - (Date.now() - t0)));
        const txt = await withDeadline(f.evaluate(() => { const el = document.getElementById('out'); return el ? el.textContent : null; }), left);
        if (txt && txt !== 'pending') {
          try { return JSON.parse(txt); } catch { return { raw: txt }; }
        }
      } catch { /* navigating */ }
    }
    if (Date.now() - t0 > timeout) return null;
    await sleep(200);
  }
}

export async function bodyText(app, tabId) {
  const f = app.tabFrame(tabId);
  if (!f) return null;
  try { return await withDeadline(f.evaluate(() => (document.body ? document.body.innerText : document.documentElement.textContent).slice(0, 20000))); } catch { return null; }
}
