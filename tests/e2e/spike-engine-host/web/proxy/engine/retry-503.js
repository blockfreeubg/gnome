/* Served with the proxy origin's 503 page for engine prefixes that reached the server (the SW was not in
 * control). Re-register the SW and retry a bounded number of times; the engine host also re-navigates. */
(async () => {
  const key = 'gnome-503-retries:' + location.pathname;
  const n = Number(sessionStorage.getItem(key) || 0);
  if (n >= 3) { document.body.append(' Giving up; reload GNOME.'); return; }
  sessionStorage.setItem(key, String(n + 1));
  try { await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }); await navigator.serviceWorker.ready; } catch {}
  setTimeout(() => location.reload(), 1000);
})();
