/* GNOME: the document-start hook (ENGINE-PROTOCOL §6.1, §6.15; WAVE-B lane a).
 * GNOME's service worker inserts this script into every HTML document Ultraviolet rewrote, right after <head>, before
 * Ultraviolet's own scripts hook the window (src/sw/pure.ts injectDocumentHook). Documents Ultraviolet leaves
 * unrewritten (SVG, XHTML, XML, HTML without a usable Content-Type) get no hook: the service worker gives them
 * `script-src 'none'`, so they run no scripts at all (ENGINE-PROTOCOL §6.15). The engine host also puts this script
 * first in every srcdoc a proxied page's script writes, in both engines (src/engine-host/webrtc.ts), because a srcdoc
 * document is a new realm that would otherwise run its scripts before anything could reach it. It only hands the window to the engine host,
 * which then attaches at document start: the WebRTC kill switch, the navigation start signal and commit observers,
 * keys, context menu, popup routing, title, CSP-violation counting, and (Wave B step 3) the WebSocket hook. It runs
 * with the proxied page's privileges and gives it nothing: an escaped page can reach the engine host anyway.
 * The walk up to the engine host uses this fresh realm's own getters: the parent documents' globals are hooked by
 * their engines (Scramjet's `frameElement` hides the tab frame from a page). */
(function () {
  'use strict';
  var me = window;
  var script = document.currentScript;
  if (script && script.parentNode) script.parentNode.removeChild(script);
  try {
    var fd = Object.getOwnPropertyDescriptor(window, 'frameElement') || Object.getOwnPropertyDescriptor(Window.prototype, 'frameElement');
    var frameElementOf = fd && fd.get;
    var ownerDocumentOf = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument').get;
    var viewOf = Object.getOwnPropertyDescriptor(Document.prototype, 'defaultView').get;
    if (!frameElementOf) return;
    var w = me;
    for (var i = 0; i < 32 && w; i++) {
      var host = w.__gnomeEngineHost;
      if (host && typeof host.attachDocument === 'function') {
        host.attachDocument(me);
        return;
      }
      var fe = frameElementOf.call(w);
      if (!fe) return;
      w = viewOf.call(ownerDocumentOf.call(fe));
    }
  } catch (e) {
    /* not inside the engine host (e.g. opened directly): nothing to attach to */
  }
})();
