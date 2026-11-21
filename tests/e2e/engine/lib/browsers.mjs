// Browsers for the Wave B e2e suites: the cached Playwright builds (chromium-1248 = Chromium 156, firefox-1555 =
// Firefox 157) through playwright-core 1.64.0, as the spike launches them (tests/e2e/spike-engine-host/lib/
// browsers.mjs), but with this runner's leak sentinel: every non-loopback destination goes to it, so a page can reach
// the internet only through Wisp. Each suite closes what it launches.
import { chromium, firefox } from 'playwright-core';
import { PORTS } from './config.mjs';

export const BROWSERS = ['chromium', 'firefox'];

export async function launch(name, { extraPrefs = {}, sentinelProxy = true, extraArgs = [] } = {}) {
  const sentinel = `127.0.0.1:${PORTS.sentinel}`;
  if (name === 'chromium') {
    const args = [...extraArgs];
    if (sentinelProxy) args.push(`--proxy-server=http://${sentinel}`);
    const opts = { headless: true, args };
    if (process.env.CHROMIUM_EXECUTABLE) opts.executablePath = process.env.CHROMIUM_EXECUTABLE;
    else opts.channel = 'chromium';
    return chromium.launch(opts);
  }
  if (name === 'firefox') {
    const prefs = { 'devtools.jsonview.enabled': false, ...extraPrefs };
    if (sentinelProxy) {
      Object.assign(prefs, {
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': PORTS.sentinel,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': PORTS.sentinel,
        'network.proxy.no_proxies_on': '',
        'network.proxy.allow_hijacking_localhost': false,
      });
    }
    const opts = { headless: true, firefoxUserPrefs: prefs };
    if (process.env.FIREFOX_EXECUTABLE) opts.executablePath = process.env.FIREFOX_EXECUTABLE;
    return firefox.launch(opts);
  }
  throw new Error(`unknown browser ${name}`);
}

export async function newContext(browser, opts = {}) {
  return browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, ...opts });
}
