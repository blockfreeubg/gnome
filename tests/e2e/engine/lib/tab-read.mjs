// Reading a proxied tab's document through the engine host's frame (same origin), for the suites that drive GNOME's
// real UI (shell-*, library-*) and the driver page alike.
//
// Why (worklist A15, measured 2026-11-19 with playwright-core 1.64 / Firefox 157): after a Scramjet tab frame was
// reloaded (GNOME's Reload, `tab.reload`), playwright's Firefox stops answering evaluations and locators in that
// frame for its later documents (`frame.evaluate` never resolves, `locator.textContent` times out), although the page
// renders and the engine host reads its DOM at once. Chromium is not affected. The engine host's own frame keeps
// answering, so the tab's document is read from there: the tab iframe is found by its `name` attribute
// (`tab-<id>`, which stays even when Scramjet renames the frame's browsing context).

/** The engine host's frame of a page (the app's or the e2e driver's), or null. */
export function engineFrame(page) {
  return page.frames().find((f) => /\/engine\/$/.test(f.url()) && !f.isDetached()) ?? null;
}

/**
 * The text of the first element matching `selector` in the tab's top document, read through the engine host; waits
 * up to `timeout` ms for it (null text or a missing element: keep waiting). Throws when it never appears.
 */
export async function tabText(page, tabId, selector, { timeout = 10_000 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const ef = engineFrame(page);
    if (ef) {
      const t = await ef
        .evaluate(
          ([id, sel]) => {
            const fr = document.querySelector(`iframe[name="tab-${id}"]`);
            try {
              const el = fr && fr.contentDocument ? fr.contentDocument.querySelector(sel) : null;
              return el ? el.textContent : null;
            } catch {
              return null;
            }
          },
          [tabId, selector],
        )
        .catch(() => null);
      if (t !== null && t !== undefined) return t;
    }
    if (Date.now() > end) throw new Error(`tab-${tabId}: ${selector} did not appear (read through the engine host)`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * A global of the tab's top document (`window[name]`), read through the engine host, or `fallback` when the frame or
 * the value cannot be read within `timeout` ms (a reloaded Scramjet frame in playwright's Firefox, worklist A15).
 */
export async function tabGlobal(page, tabId, name, { timeout = 8_000, fallback = 'unreadable' } = {}) {
  const ef = engineFrame(page);
  if (!ef) return fallback;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeout);
  });
  try {
    return await Promise.race([
      ef
        .evaluate(
          ([id, key]) => {
            const fr = document.querySelector(`iframe[name="tab-${id}"]`);
            try {
              const v = fr && fr.contentWindow ? fr.contentWindow[key] : undefined;
              return v === undefined ? null : v;
            } catch {
              return 'unreadable';
            }
          },
          [tabId, name],
        )
        .catch(() => fallback),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
