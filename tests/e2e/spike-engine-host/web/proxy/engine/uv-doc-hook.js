/* Document-start hook for Ultraviolet documents. GNOME's SW inserts this script as the first child of <head>
 * of every UV-proxied HTML document, before UV's own scripts hook the window, so the engine host can attach its
 * observers (keys, context menu, title, fullscreen, URL) at document start, as Scramjet's init.post allows.
 * It runs with the proxied page's privileges; it only hands the window to the engine host. */
(() => {
  const self_ = window;
  const script = document.currentScript;
  if (script) script.remove();
  let w = self_;
  try {
    for (let i = 0; i < 32 && w; i++) {
      if (w.__gnomeEngineHost) return void w.__gnomeEngineHost.attachDocument(self_, 'ultraviolet');
      const fe = w.frameElement;
      if (!fe) return;
      w = fe.ownerDocument.defaultView;
    }
  } catch {
    /* not inside the engine host (e.g. opened as a popup): nothing to attach to */
  }
})();
